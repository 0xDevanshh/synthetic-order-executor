// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";
import {IWETH9} from "./interfaces/IWETH9.sol";

/**
 * @title SyntheticOrderExecutor
 * @notice Restricted on-chain execution layer for off-chain synthetic trading orders.
 *
 * @dev DIVISION OF RESPONSIBILITY
 *
 *      This contract does NOT decide when an order should execute. It holds no
 *      trigger prices, no oracle reads and no order book. The backend watches
 *      the price and decides WHEN.
 *
 *      This contract decides HOW a trade is permitted to happen:
 *        - only an authorized executor may submit it
 *        - only allowlisted tokens may be traded
 *        - only up to a per-token maximum size
 *        - only above a caller-supplied minimum output (slippage floor)
 *        - only before a deadline
 *        - only once per executionId
 *        - only while not paused
 *
 *      CUSTODY MODEL
 *
 *      This is a per-user vault, not an allowance spender. Users deposit and
 *      the contract tracks `balances[user][token]`. A swap debits the order
 *      owner's balance and credits the proceeds straight back to that same
 *      owner. Only the owner can withdraw their own balance, and withdrawals
 *      keep working while the contract is paused.
 *
 *      Consequently there is no generic
 *      `withdraw(token, recipient, amount)` admin function anywhere in this
 *      contract. The only admin token movement is `sweepUnaccounted`, which is
 *      arithmetically bounded to `balanceOf(this) - totalAccounted[token]` and
 *      therefore cannot touch user funds. See the README for the full argument.
 *
 *      TARGET NETWORK
 *
 *      Ethereum Sepolia, chain id 11155111.
 *      Uniswap V3 SwapRouter02: 0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E
 *      (verified against the official Uniswap deployments documentation.)
 */
contract SyntheticOrderExecutor is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Roles
    // -------------------------------------------------------------------------

    /// @notice May call `executeSwap`. Held by the backend's hot wallet.
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    /// @notice May call `pause`. Unpausing is admin-only by design: stopping the
    ///         system should be cheap, resuming it should be deliberate.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // -------------------------------------------------------------------------
    // Immutables
    // -------------------------------------------------------------------------

    /// @notice Uniswap V3 SwapRouter02. Immutable, so this contract can never be
    ///         redirected at an arbitrary external call target.
    ISwapRouter02 public immutable swapRouter;

    /// @notice Canonical WETH9, used by the ETH deposit/withdraw convenience path.
    IWETH9 public immutable weth;

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /// @notice user => token => vault balance.
    mapping(address => mapping(address => uint256)) public balances;

    /// @notice token => sum of all user balances. Anything the contract holds
    ///         above this figure is unaccounted dust.
    mapping(address => uint256) public totalAccounted;

    /// @notice token => tradeable and depositable.
    mapping(address => bool) public allowedToken;

    /// @notice token => maximum `amountIn` for a single swap, in token units.
    mapping(address => uint256) public maxTradeAmount;

    /// @notice executionId => already executed. The replay guard.
    mapping(bytes32 => bool) public executedIds;

    /// @notice The current authorized executor. Mirrors EXECUTOR_ROLE for the
    ///         single-executor deployment the backend actually uses, and gives
    ///         `ExecutorUpdated` something meaningful to report.
    address public executor;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice A swap completed. Primary reconciliation source for the backend.
    event SwapExecuted(
        bytes32 indexed executionId,
        address indexed owner,
        address indexed executorAddress,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 minAmountOut,
        uint24 poolFee
    );

    event ExecutorUpdated(address indexed previousExecutor, address indexed newExecutor);
    event TokenAllowed(address indexed token, uint256 maxTradeAmount);
    event TokenRemoved(address indexed token);
    event MaxTradeAmountUpdated(address indexed token, uint256 previousAmount, uint256 newAmount);

    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event UnaccountedSwept(address indexed token, address indexed to, uint256 amount);

    // `Paused(address)` and `Unpaused(address)` come from OpenZeppelin Pausable.

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error TokenNotAllowed(address token);
    error IdenticalTokens();
    error ExecutionAlreadyProcessed(bytes32 executionId);
    error InvalidExecutionId();
    error TradeTooLarge(uint256 amountIn, uint256 maxAmount);
    error InsufficientBalance(uint256 available, uint256 required);
    error DeadlineExpired(uint256 deadline, uint256 nowTimestamp);
    error SlippageExceeded(uint256 amountOut, uint256 minAmountOut);
    error NothingToSweep();
    error EthTransferFailed();
    error DirectEthNotAccepted();

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /**
     * @param _swapRouter Uniswap V3 SwapRouter02.
     * @param _weth       Canonical WETH9.
     * @param _admin      DEFAULT_ADMIN_ROLE holder. Should be a multisig or
     *                    timelock in production.
     * @param _executor   Initial authorized executor. May be address(0) to
     *                    defer granting until the configure step, so the
     *                    deployer key never holds execution rights.
     */
    constructor(address _swapRouter, address _weth, address _admin, address _executor) {
        if (_swapRouter == address(0) || _weth == address(0) || _admin == address(0)) {
            revert ZeroAddress();
        }

        swapRouter = ISwapRouter02(_swapRouter);
        weth = IWETH9(_weth);

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(PAUSER_ROLE, _admin);

        if (_executor != address(0)) {
            executor = _executor;
            _grantRole(EXECUTOR_ROLE, _executor);
            emit ExecutorUpdated(address(0), _executor);
        }
    }

    // -------------------------------------------------------------------------
    // Vault: deposits
    // -------------------------------------------------------------------------

    /**
     * @notice Deposit an allowlisted ERC20 into the caller's vault balance.
     * @dev Credits the amount actually received, so a token that transfers less
     *      than requested cannot inflate the caller's balance. Fee-on-transfer
     *      and rebasing tokens remain out of scope — the allowlist is the
     *      mitigation, this is just belt and braces.
     */
    function deposit(address token, uint256 amount) external whenNotPaused nonReentrant {
        if (!allowedToken[token]) revert TokenNotAllowed(token);
        if (amount == 0) revert ZeroAmount();

        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;
        if (received == 0) revert ZeroAmount();

        balances[msg.sender][token] += received;
        totalAccounted[token] += received;

        emit Deposited(msg.sender, token, received);
    }

    /// @notice Wrap `msg.value` into WETH and credit it to the caller's vault.
    function depositETH() external payable whenNotPaused nonReentrant {
        if (msg.value == 0) revert ZeroAmount();

        address wethAddress = address(weth);
        if (!allowedToken[wethAddress]) revert TokenNotAllowed(wethAddress);

        weth.deposit{value: msg.value}();

        balances[msg.sender][wethAddress] += msg.value;
        totalAccounted[wethAddress] += msg.value;

        emit Deposited(msg.sender, wethAddress, msg.value);
    }

    // -------------------------------------------------------------------------
    // Vault: withdrawals
    //
    // Note what is absent here: there is no function that lets any role move
    // another account's balance. Withdrawal is always msg.sender-scoped.
    // -------------------------------------------------------------------------

    /**
     * @notice Withdraw the caller's own vault balance.
     * @dev Deliberately NOT `whenNotPaused`. A pause stops new trading; it must
     *      never trap user funds. Not restricted to allowlisted tokens either —
     *      de-allowlisting a token must not strand balances held in it.
     */
    function withdraw(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        uint256 available = balances[msg.sender][token];
        if (available < amount) revert InsufficientBalance(available, amount);

        // Effects before interactions.
        balances[msg.sender][token] = available - amount;
        totalAccounted[token] -= amount;

        IERC20(token).safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, token, amount);
    }

    /// @notice Withdraw WETH from the caller's vault, unwrapped to native ETH.
    function withdrawETH(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        address wethAddress = address(weth);
        uint256 available = balances[msg.sender][wethAddress];
        if (available < amount) revert InsufficientBalance(available, amount);

        balances[msg.sender][wethAddress] = available - amount;
        totalAccounted[wethAddress] -= amount;

        weth.withdraw(amount);

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert EthTransferFailed();

        emit Withdrawn(msg.sender, wethAddress, amount);
    }

    // -------------------------------------------------------------------------
    // Execution
    // -------------------------------------------------------------------------

    /**
     * @notice Execute a single-hop `tokenIn -> tokenOut` swap through Uniswap V3
     *         on behalf of `owner`, subject to every on-chain restriction.
     *
     * @param executionId  Unique identifier for this execution, chosen by the
     *                     backend. Replaying it is impossible.
     * @param owner        The account whose vault balance funds the swap and
     *                     receives the proceeds.
     * @param tokenIn      Token sold. Must be allowlisted.
     * @param tokenOut     Token bought. Must be allowlisted.
     * @param poolFee      Uniswap V3 fee tier (500 / 3000 / 10000), selected
     *                     off-chain by quoting each tier.
     * @param amountIn     Exact input amount. Capped by `maxTradeAmount[tokenIn]`.
     * @param minAmountOut Slippage floor. The swap reverts below it.
     * @param deadline     Unix timestamp after which this execution is invalid.
     *
     * @return amountOut   Output actually received and credited to `owner`.
     *
     * @dev Two parameters extend the shape sketched in the brief, both forced by
     *      requirements elsewhere in it:
     *        - `owner`, because funds are attributable per user. Without it
     *          there is no way to debit a specific user and credit them back,
     *          and requirement 10 (no unrestricted movement of user funds)
     *          could not be satisfied.
     *        - `poolFee`, because Uniswap V3 pools are per-fee-tier. There is no
     *          single canonical WETH/USDC pool to route through.
     *
     *      Ordering is strict checks-effects-interactions: `executedIds` is set
     *      and the balance is debited BEFORE the router is called, so replay is
     *      impossible even if `tokenIn` re-enters.
     */
    function executeSwap(
        bytes32 executionId,
        address owner,
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    )
        external
        onlyRole(EXECUTOR_ROLE)
        whenNotPaused
        nonReentrant
        returns (uint256 amountOut)
    {
        // ---- checks ----------------------------------------------------------
        if (executionId == bytes32(0)) revert InvalidExecutionId();
        if (executedIds[executionId]) revert ExecutionAlreadyProcessed(executionId);
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
        if (owner == address(0)) revert ZeroAddress();
        if (tokenIn == tokenOut) revert IdenticalTokens();
        if (!allowedToken[tokenIn]) revert TokenNotAllowed(tokenIn);
        if (!allowedToken[tokenOut]) revert TokenNotAllowed(tokenOut);
        if (amountIn == 0) revert ZeroAmount();

        uint256 maxAmount = maxTradeAmount[tokenIn];
        if (amountIn > maxAmount) revert TradeTooLarge(amountIn, maxAmount);

        uint256 available = balances[owner][tokenIn];
        if (available < amountIn) revert InsufficientBalance(available, amountIn);

        // ---- effects ---------------------------------------------------------
        // Set before any external call. This is what makes duplicate execution
        // impossible rather than merely unlikely.
        executedIds[executionId] = true;

        balances[owner][tokenIn] = available - amountIn;
        totalAccounted[tokenIn] -= amountIn;

        // ---- interactions ----------------------------------------------------
        amountOut = _swapExactInputSingle(tokenIn, tokenOut, poolFee, amountIn, minAmountOut);

        // Redundant with the router's own check, but this contract states its
        // own guarantee rather than borrowing one.
        if (amountOut < minAmountOut) revert SlippageExceeded(amountOut, minAmountOut);

        balances[owner][tokenOut] += amountOut;
        totalAccounted[tokenOut] += amountOut;

        emit SwapExecuted(
            executionId,
            owner,
            msg.sender,
            tokenIn,
            tokenOut,
            amountIn,
            amountOut,
            minAmountOut,
            poolFee
        );
    }

    /**
     * @dev Single-hop exact-input swap with a scoped approval.
     *
     *      The approval is granted for exactly `amountIn` immediately before the
     *      call and reset to zero immediately after, rather than left standing
     *      and infinite. Costs a little gas, shrinks the blast radius if the
     *      router is ever compromised.
     *
     *      `recipient` is this contract, not the order owner: proceeds land in
     *      the vault and are credited internally, so they stay under the same
     *      constraints as the rest of the user's balance.
     *
     *      Note SwapRouter02's ExactInputSingleParams has no `deadline` field
     *      (that was the legacy SwapRouter), which is precisely why
     *      `executeSwap` enforces the deadline itself against `block.timestamp`.
     */
    function _swapExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 amountIn,
        uint256 minAmountOut
    ) internal returns (uint256 amountOut) {
        IERC20(tokenIn).forceApprove(address(swapRouter), amountIn);

        amountOut = swapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: poolFee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minAmountOut,
                sqrtPriceLimitX96: 0
            })
        );

        // Leave no standing allowance, including when the router pulled less
        // than it was approved for.
        IERC20(tokenIn).forceApprove(address(swapRouter), 0);
    }

    // -------------------------------------------------------------------------
    // Admin: executor management
    // -------------------------------------------------------------------------

    /**
     * @notice Rotate the authorized executor.
     * @dev Revokes EXECUTOR_ROLE from the previous holder in the same call, so
     *      key rotation cannot silently leave two live executors behind.
     *      Passing address(0) revokes without appointing a replacement, which is
     *      the fastest way to disable execution without a full pause.
     */
    function setExecutor(address newExecutor) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address previous = executor;
        if (previous == newExecutor) return;

        if (previous != address(0)) {
            _revokeRole(EXECUTOR_ROLE, previous);
        }

        executor = newExecutor;

        if (newExecutor != address(0)) {
            _grantRole(EXECUTOR_ROLE, newExecutor);
        }

        emit ExecutorUpdated(previous, newExecutor);
    }

    // -------------------------------------------------------------------------
    // Admin: token allowlist and trade limits
    // -------------------------------------------------------------------------

    /**
     * @notice Allowlist a token and set its maximum single-trade size.
     * @dev The two are set together deliberately. Allowlisting without a cap
     *      would leave `maxTradeAmount` at zero, and every trade would revert —
     *      a confusing failure to debug. Requiring the cap up front makes the
     *      misconfiguration impossible.
     */
    function setTokenAllowed(address token, uint256 maxAmount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        if (maxAmount == 0) revert ZeroAmount();

        allowedToken[token] = true;
        maxTradeAmount[token] = maxAmount;

        emit TokenAllowed(token, maxAmount);
    }

    /**
     * @notice Remove a token from the allowlist.
     * @dev Blocks new deposits and new trades. Existing holders can still
     *      `withdraw` — de-allowlisting must not strand funds.
     */
    function removeToken(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!allowedToken[token]) revert TokenNotAllowed(token);

        allowedToken[token] = false;
        maxTradeAmount[token] = 0;

        emit TokenRemoved(token);
    }

    /// @notice Update the maximum single-trade size for an allowlisted token.
    function setMaxTradeAmount(address token, uint256 newAmount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!allowedToken[token]) revert TokenNotAllowed(token);
        if (newAmount == 0) revert ZeroAmount();

        uint256 previous = maxTradeAmount[token];
        maxTradeAmount[token] = newAmount;

        emit MaxTradeAmountUpdated(token, previous, newAmount);
    }

    // -------------------------------------------------------------------------
    // Admin: emergency stop
    // -------------------------------------------------------------------------

    /// @notice Halt deposits and executions. Withdrawals keep working.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resume. Admin-only, intentionally stricter than pausing.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // -------------------------------------------------------------------------
    // Admin: bounded recovery
    // -------------------------------------------------------------------------

    /**
     * @notice Recover tokens sent to this contract outside the deposit flow.
     *
     * @dev THIS IS THE ONLY ADMIN TOKEN-MOVEMENT FUNCTION, and it is bounded by
     *      arithmetic rather than by policy:
     *
     *          sweepable = balanceOf(this) - totalAccounted[token]
     *
     *      `totalAccounted[token]` is the exact sum of every user's balance in
     *      that token, maintained on every deposit, withdrawal and swap. So the
     *      sweepable amount is by construction the portion of the contract's
     *      holdings that no user has a claim to. A compromised admin key cannot
     *      use this to take user funds — there is no input that makes it move
     *      more than the surplus.
     *
     *      This is the deliberate alternative to a generic
     *      `withdraw(token, recipient, amount)`, which would give the admin key
     *      unrestricted access to every deposit in the contract.
     */
    function sweepUnaccounted(address token, address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();

        uint256 amount = unaccountedBalance(token);
        if (amount == 0) revert NothingToSweep();

        IERC20(token).safeTransfer(to, amount);

        emit UnaccountedSwept(token, to, amount);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @notice Tokens held in excess of every user's claim. The sweepable surplus.
    function unaccountedBalance(address token) public view returns (uint256) {
        uint256 held = IERC20(token).balanceOf(address(this));
        uint256 owed = totalAccounted[token];
        return held > owed ? held - owed : 0;
    }

    /// @notice True once `executionId` has been executed. The backend's
    ///         reconciliation probe for resolving ambiguous transactions.
    function isExecuted(bytes32 executionId) external view returns (bool) {
        return executedIds[executionId];
    }

    /// @notice Convenience view for the frontend.
    function getBalance(address user, address token) external view returns (uint256) {
        return balances[user][token];
    }

    // -------------------------------------------------------------------------
    // ETH
    // -------------------------------------------------------------------------

    /// @dev Accept ETH only from WETH unwrapping during `withdrawETH`. Anything
    ///      else would create an unattributable balance.
    receive() external payable {
        if (msg.sender != address(weth)) revert DirectEthNotAccepted();
    }
}
