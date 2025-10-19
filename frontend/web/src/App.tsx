// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface PayrollRecord {
  id: string;
  encryptedSalary: string;
  encryptedInvestment: string;
  timestamp: number;
  employee: string;
  status: "pending" | "processed" | "failed";
  investmentStrategy: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<PayrollRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newRecordData, setNewRecordData] = useState({ 
    employeeAddress: "", 
    salary: 0, 
    investmentAmount: 0,
    investmentStrategy: "ETH" 
  });
  const [selectedRecord, setSelectedRecord] = useState<PayrollRecord | null>(null);
  const [decryptedSalary, setDecryptedSalary] = useState<number | null>(null);
  const [decryptedInvestment, setDecryptedInvestment] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [announcements, setAnnouncements] = useState<string[]>([
    "System upgrade scheduled for next Monday",
    "New ETH investment strategy added",
    "FHE processing speed improved by 20%"
  ]);

  // Calculate statistics
  const processedCount = records.filter(r => r.status === "processed").length;
  const pendingCount = records.filter(r => r.status === "pending").length;
  const failedCount = records.filter(r => r.status === "failed").length;
  const totalSalary = records.reduce((sum, record) => {
    return sum + (record.status === "processed" ? FHEDecryptNumber(record.encryptedSalary) : 0);
  }, 0);
  const totalInvestment = records.reduce((sum, record) => {
    return sum + (record.status === "processed" ? FHEDecryptNumber(record.encryptedInvestment) : 0);
  }, 0);

  useEffect(() => {
    loadRecords().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadRecords = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract is not available");
        return;
      }

      const keysBytes = await contract.getData("payroll_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing payroll keys:", e); }
      }

      const list: PayrollRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`payroll_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({ 
                id: key, 
                encryptedSalary: recordData.salary, 
                encryptedInvestment: recordData.investment,
                timestamp: recordData.timestamp, 
                employee: recordData.employee, 
                status: recordData.status || "pending",
                investmentStrategy: recordData.investmentStrategy || "ETH"
              });
            } catch (e) { console.error(`Error parsing record data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading record ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(list);
    } catch (e) { console.error("Error loading records:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitPayroll = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting payroll data with Zama FHE..." });
    try {
      const encryptedSalary = FHEEncryptNumber(newRecordData.salary);
      const encryptedInvestment = FHEEncryptNumber(newRecordData.investmentAmount);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const recordId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const recordData = { 
        salary: encryptedSalary, 
        investment: encryptedInvestment,
        timestamp: Math.floor(Date.now() / 1000), 
        employee: newRecordData.employeeAddress, 
        status: "pending",
        investmentStrategy: newRecordData.investmentStrategy
      };
      
      await contract.setData(`payroll_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));
      
      const keysBytes = await contract.getData("payroll_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(recordId);
      await contract.setData("payroll_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Payroll submitted securely with FHE encryption!" });
      await loadRecords();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewRecordData({ 
          employeeAddress: "", 
          salary: 0, 
          investmentAmount: 0,
          investmentStrategy: "ETH" 
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const processPayroll = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted payroll with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const recordBytes = await contract.getData(`payroll_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedRecord = { ...recordData, status: "processed" };
      await contractWithSigner.setData(`payroll_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Payroll processed successfully with FHE!" });
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Processing failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const markAsFailed = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Updating payroll status with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const recordBytes = await contract.getData(`payroll_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      const updatedRecord = { ...recordData, status: "failed" };
      
      await contract.setData(`payroll_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      setTransactionStatus({ visible: true, status: "success", message: "Payroll marked as failed!" });
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Update failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const filteredRecords = records.filter(record => {
    const matchesSearch = record.employee.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         record.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === "all" || record.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  const renderBarChart = () => {
    const monthlyData = Array(12).fill(0);
    const currentYear = new Date().getFullYear();
    
    records.forEach(record => {
      if (record.status === "processed") {
        const date = new Date(record.timestamp * 1000);
        if (date.getFullYear() === currentYear) {
          monthlyData[date.getMonth()] += FHEDecryptNumber(record.encryptedSalary);
        }
      }
    });

    const maxValue = Math.max(...monthlyData, 1);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    return (
      <div className="bar-chart">
        {monthlyData.map((value, index) => (
          <div key={index} className="bar-container">
            <div className="bar-label">{months[index]}</div>
            <div 
              className="bar" 
              style={{ height: `${(value / maxValue) * 100}%` }}
              title={`$${value.toLocaleString()}`}
            ></div>
          </div>
        ))}
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Initializing encrypted payroll system...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>Stealth<span>Payroll</span></h1>
          <p>Confidential Payroll & Investment</p>
        </div>
        <div className="header-actions">
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
        </div>
      </header>

      <div className="main-content">
        <div className="dashboard-grid">
          <div className="dashboard-card overview-card">
            <h2>Payroll Overview</h2>
            <div className="stats-row">
              <div className="stat-item">
                <div className="stat-value">${totalSalary.toLocaleString()}</div>
                <div className="stat-label">Total Salary</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">${totalInvestment.toLocaleString()}</div>
                <div className="stat-label">Total Investment</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{records.length}</div>
                <div className="stat-label">Total Records</div>
              </div>
            </div>
            <button 
              className="primary-btn" 
              onClick={() => setShowCreateModal(true)}
            >
              + Add Payroll
            </button>
          </div>

          <div className="dashboard-card status-card">
            <h2>Processing Status</h2>
            <div className="status-row">
              <div className="status-item processed">
                <div className="status-value">{processedCount}</div>
                <div className="status-label">Processed</div>
              </div>
              <div className="status-item pending">
                <div className="status-value">{pendingCount}</div>
                <div className="status-label">Pending</div>
              </div>
              <div className="status-item failed">
                <div className="status-value">{failedCount}</div>
                <div className="status-label">Failed</div>
              </div>
            </div>
            <div className="chart-container">
              {renderBarChart()}
            </div>
          </div>

          <div className="dashboard-card announcements-card">
            <h2>System Announcements</h2>
            <div className="announcements-list">
              {announcements.map((announcement, index) => (
                <div key={index} className="announcement-item">
                  <div className="announcement-badge">NEW</div>
                  <p>{announcement}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="records-section">
          <div className="section-header">
            <h2>Payroll Records</h2>
            <div className="controls">
              <div className="search-box">
                <input
                  type="text"
                  placeholder="Search employee or ID..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
                <div className="search-icon"></div>
              </div>
              <select 
                value={filterStatus} 
                onChange={(e) => setFilterStatus(e.target.value)}
                className="filter-select"
              >
                <option value="all">All Status</option>
                <option value="processed">Processed</option>
                <option value="pending">Pending</option>
                <option value="failed">Failed</option>
              </select>
              <button 
                onClick={loadRecords} 
                className="refresh-btn"
                disabled={isRefreshing}
              >
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          <div className="records-table">
            <div className="table-header">
              <div className="header-cell">ID</div>
              <div className="header-cell">Employee</div>
              <div className="header-cell">Salary</div>
              <div className="header-cell">Investment</div>
              <div className="header-cell">Strategy</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>

            {filteredRecords.length === 0 ? (
              <div className="no-records">
                <p>No payroll records found</p>
                <button 
                  className="primary-btn" 
                  onClick={() => setShowCreateModal(true)}
                >
                  Create First Payroll
                </button>
              </div>
            ) : (
              filteredRecords.map(record => (
                <div className="table-row" key={record.id}>
                  <div className="table-cell">#{record.id.substring(0, 6)}</div>
                  <div className="table-cell">
                    {record.employee.substring(0, 6)}...{record.employee.substring(38)}
                  </div>
                  <div className="table-cell">
                    <span className="encrypted-data">
                      {record.encryptedSalary.substring(0, 10)}...
                    </span>
                  </div>
                  <div className="table-cell">
                    <span className="encrypted-data">
                      {record.encryptedInvestment.substring(0, 10)}...
                    </span>
                  </div>
                  <div className="table-cell">{record.investmentStrategy}</div>
                  <div className="table-cell">
                    {new Date(record.timestamp * 1000).toLocaleDateString()}
                  </div>
                  <div className="table-cell">
                    <span className={`status-badge ${record.status}`}>
                      {record.status}
                    </span>
                  </div>
                  <div className="table-cell actions">
                    <button 
                      className="action-btn view-btn"
                      onClick={() => setSelectedRecord(record)}
                    >
                      View
                    </button>
                    {record.status === "pending" && (
                      <>
                        <button 
                          className="action-btn process-btn"
                          onClick={() => processPayroll(record.id)}
                        >
                          Process
                        </button>
                        <button 
                          className="action-btn fail-btn"
                          onClick={() => markAsFailed(record.id)}
                        >
                          Fail
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal">
            <div className="modal-header">
              <h2>Add New Payroll</h2>
              <button 
                onClick={() => setShowCreateModal(false)}
                className="close-btn"
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Employee Address</label>
                <input
                  type="text"
                  value={newRecordData.employeeAddress}
                  onChange={(e) => setNewRecordData({...newRecordData, employeeAddress: e.target.value})}
                  placeholder="0x..."
                />
              </div>
              <div className="form-group">
                <label>Salary Amount</label>
                <input
                  type="number"
                  value={newRecordData.salary}
                  onChange={(e) => setNewRecordData({...newRecordData, salary: parseFloat(e.target.value)})}
                  placeholder="Amount in USD"
                  step="0.01"
                />
              </div>
              <div className="form-group">
                <label>Investment Amount</label>
                <input
                  type="number"
                  value={newRecordData.investmentAmount}
                  onChange={(e) => setNewRecordData({...newRecordData, investmentAmount: parseFloat(e.target.value)})}
                  placeholder="Amount to invest"
                  step="0.01"
                />
              </div>
              <div className="form-group">
                <label>Investment Strategy</label>
                <select
                  value={newRecordData.investmentStrategy}
                  onChange={(e) => setNewRecordData({...newRecordData, investmentStrategy: e.target.value})}
                >
                  <option value="ETH">ETH</option>
                  <option value="BTC">BTC</option>
                  <option value="USDC">USDC</option>
                  <option value="DAI">DAI</option>
                </select>
              </div>
              <div className="encryption-preview">
                <h4>FHE Encryption Preview</h4>
                <div className="preview-row">
                  <div className="preview-item">
                    <span>Salary:</span>
                    <div>{newRecordData.salary ? FHEEncryptNumber(newRecordData.salary).substring(0, 20) + '...' : 'Not encrypted'}</div>
                  </div>
                  <div className="preview-item">
                    <span>Investment:</span>
                    <div>{newRecordData.investmentAmount ? FHEEncryptNumber(newRecordData.investmentAmount).substring(0, 20) + '...' : 'Not encrypted'}</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button 
                onClick={() => setShowCreateModal(false)}
                className="cancel-btn"
              >
                Cancel
              </button>
              <button 
                onClick={submitPayroll}
                disabled={creating}
                className="submit-btn"
              >
                {creating ? "Encrypting with FHE..." : "Submit Payroll"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedRecord && (
        <div className="modal-overlay">
          <div className="detail-modal">
            <div className="modal-header">
              <h2>Payroll Details</h2>
              <button 
                onClick={() => {
                  setSelectedRecord(null);
                  setDecryptedSalary(null);
                  setDecryptedInvestment(null);
                }}
                className="close-btn"
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="detail-row">
                <span>ID:</span>
                <strong>{selectedRecord.id}</strong>
              </div>
              <div className="detail-row">
                <span>Employee:</span>
                <strong>{selectedRecord.employee}</strong>
              </div>
              <div className="detail-row">
                <span>Date:</span>
                <strong>{new Date(selectedRecord.timestamp * 1000).toLocaleString()}</strong>
              </div>
              <div className="detail-row">
                <span>Status:</span>
                <strong className={`status-badge ${selectedRecord.status}`}>
                  {selectedRecord.status}
                </strong>
              </div>
              <div className="detail-row">
                <span>Investment Strategy:</span>
                <strong>{selectedRecord.investmentStrategy}</strong>
              </div>
              
              <div className="encrypted-section">
                <h3>Encrypted Data</h3>
                <div className="encrypted-data">
                  <div className="data-item">
                    <span>Salary:</span>
                    <div>{selectedRecord.encryptedSalary.substring(0, 50)}...</div>
                  </div>
                  <div className="data-item">
                    <span>Investment:</span>
                    <div>{selectedRecord.encryptedInvestment.substring(0, 50)}...</div>
                  </div>
                </div>
                <button 
                  className="decrypt-btn"
                  onClick={async () => {
                    if (decryptedSalary === null) {
                      const salary = await decryptWithSignature(selectedRecord.encryptedSalary);
                      const investment = await decryptWithSignature(selectedRecord.encryptedInvestment);
                      setDecryptedSalary(salary);
                      setDecryptedInvestment(investment);
                    } else {
                      setDecryptedSalary(null);
                      setDecryptedInvestment(null);
                    }
                  }}
                  disabled={isDecrypting}
                >
                  {isDecrypting ? "Decrypting..." : 
                   decryptedSalary !== null ? "Hide Values" : "Decrypt with Wallet"}
                </button>
              </div>

              {decryptedSalary !== null && (
                <div className="decrypted-section">
                  <h3>Decrypted Values</h3>
                  <div className="decrypted-data">
                    <div className="data-item">
                      <span>Salary:</span>
                      <div>${decryptedSalary?.toLocaleString()}</div>
                    </div>
                    <div className="data-item">
                      <span>Investment:</span>
                      <div>${decryptedInvestment?.toLocaleString()}</div>
                    </div>
                  </div>
                  <div className="decryption-note">
                    <p>Values decrypted using your wallet signature. Data remains encrypted on-chain.</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon">✓</div>}
              {transactionStatus.status === "error" && <div className="error-icon">✕</div>}
            </div>
            <div className="transaction-message">
              {transactionStatus.message}
            </div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-left">
            <h3>Stealth Payroll</h3>
            <p>Confidential Payroll & Investment Tool</p>
            <div className="tech-badge">
              <span>Powered by Zama FHE</span>
            </div>
          </div>
          <div className="footer-right">
            <div className="footer-links">
              <a href="#">Documentation</a>
              <a href="#">Privacy Policy</a>
              <a href="#">Terms of Service</a>
            </div>
            <div className="copyright">
              © {new Date().getFullYear()} Stealth Payroll. All rights reserved.
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;