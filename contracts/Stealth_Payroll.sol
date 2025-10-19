pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract StealthPayrollFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error InvalidAddress();
    error InvalidCooldown();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Employee {
        euint32 encryptedSalary;
        euint32 encryptedInvestmentPercentage; // e.g., 0 for 0%, 10 for 10%. Max 100.
        bool isActive;
    }

    struct Batch {
        uint256 id;
        bool isOpen;
        uint256 employeeCount;
        mapping(uint256 => Employee) employees; // employeeId -> Employee
    }

    uint256 public currentBatchId;
    mapping(uint256 => Batch) public batches;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PauseToggled(bool paused);
    event CooldownSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event EmployeeDataSubmitted(uint256 indexed batchId, uint256 indexed employeeId, address indexed provider);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalSalary, uint256 totalInvestmentAmount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60; // Default 1 minute cooldown
        currentBatchId = 1; // Start with batch 1
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidAddress();
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            delete isProvider[provider];
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseToggled(_paused);
    }

    function setCooldown(uint256 _cooldownSeconds) external onlyOwner {
        if (_cooldownSeconds == 0) revert InvalidCooldown();
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSet(oldCooldown, _cooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        Batch storage batch = batches[currentBatchId];
        batch.id = currentBatchId;
        batch.isOpen = true;
        batch.employeeCount = 0;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batches[currentBatchId].isOpen) revert BatchClosed();
        batches[currentBatchId].isOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitEmployeeData(
        uint256 employeeId,
        euint32 encryptedSalary,
        euint32 encryptedInvestmentPercentage
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        Batch storage currentBatch = batches[currentBatchId];
        if (!currentBatch.isOpen) revert BatchClosed();

        _initIfNeeded(encryptedSalary);
        _initIfNeeded(encryptedInvestmentPercentage);

        Employee storage emp = currentBatch.employees[employeeId];
        emp.encryptedSalary = encryptedSalary;
        emp.encryptedInvestmentPercentage = encryptedInvestmentPercentage;
        emp.isActive = true;

        if (emp.isActive) { // If already active, don't increment count
            currentBatch.employeeCount++;
        }
        lastSubmissionTime[msg.sender] = block.timestamp;

        emit EmployeeDataSubmitted(currentBatchId, employeeId, msg.sender);
    }

    function requestBatchSummaryDecryption(uint256 batchId)
        external
        onlyProvider
        whenNotPaused
        checkDecryptionCooldown
    {
        Batch storage batch = batches[batchId];
        if (batch.employeeCount == 0) revert("No employees in batch");

        euint32 totalSalaryEnc = FHE.asEuint32(0);
        euint32 totalInvestmentEnc = FHE.asEuint32(0);

        for (uint256 i = 0; i < batch.employeeCount; ) {
            Employee storage emp = batch.employees[i]; // Assuming employeeId is dense 0..count-1
            if (emp.isActive) {
                totalSalaryEnc = totalSalaryEnc.add(emp.encryptedSalary);
                euint32 investmentAmountEnc = emp.encryptedSalary.mul(emp.encryptedInvestmentPercentage).div(FHE.asEuint32(100));
                totalInvestmentEnc = totalInvestmentEnc.add(investmentAmountEnc);
            }
            unchecked {
                i++;
            }
        }

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = totalSalaryEnc.toBytes32();
        cts[1] = totalInvestmentEnc.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);

        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        DecryptionContext storage ctx = decryptionContexts[requestId];

        if (ctx.processed) revert ReplayAttempt();
        // Security: Replay protection ensures this callback is processed only once for a given requestId.

        Batch storage batch = batches[ctx.batchId];
        euint32 totalSalaryEnc = FHE.asEuint32(0);
        euint32 totalInvestmentEnc = FHE.asEuint32(0);

        for (uint256 i = 0; i < batch.employeeCount; ) {
            Employee storage emp = batch.employees[i];
            if (emp.isActive) {
                totalSalaryEnc = totalSalaryEnc.add(emp.encryptedSalary);
                euint32 investmentAmountEnc = emp.encryptedSalary.mul(emp.encryptedInvestmentPercentage).div(FHE.asEuint32(100));
                totalInvestmentEnc = totalInvestmentEnc.add(investmentAmountEnc);
            }
            unchecked {
                i++;
            }
        }
        bytes32[] memory currentCts = new bytes32[](2);
        currentCts[0] = totalSalaryEnc.toBytes32();
        currentCts[1] = totalInvestmentEnc.toBytes32();

        bytes32 currentHash = _hashCiphertexts(currentCts);
        // Security: State hash verification ensures that the contract state (specifically, the ciphertexts
        // that were intended for decryption) has not changed between the requestDecryption call and this callback.
        if (currentHash != ctx.stateHash) revert StateMismatch();

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();

        (uint32 totalSalaryCleartext, uint32 totalInvestmentCleartext) = abi.decode(cleartexts, (uint32, uint32));

        ctx.processed = true;
        emit DecryptionCompleted(requestId, ctx.batchId, totalSalaryCleartext, totalInvestmentCleartext);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 val) internal {
        if (!val.isInitialized()) revert NotInitialized();
    }

    function _initIfNeeded(ebool val) internal {
        if (!val.isInitialized()) revert NotInitialized();
    }
}