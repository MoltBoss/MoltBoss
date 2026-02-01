import type { Payout } from "@shared/schema";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY!;
const REGISTRATION_WALLET = "CKpRpJ2JTi7LuvoMRp4wKdzZbW6gZHhY612Rz5fLwpJ8";
const REGISTRATION_FEE = 0.1; // SOL

interface TransferVerification {
  valid: boolean;
  amount?: number;
  error?: string;
}

interface NativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number;
}

interface HeliusTransaction {
  signature: string;
  timestamp: number;
  transactionError: string | null;
  nativeTransfers?: NativeTransfer[];
}

/**
 * Verify that a SOL transfer was made from a wallet to the registration wallet
 */
export async function verifyRegistrationPayment(
  txSignature: string,
  fromWallet: string
): Promise<TransferVerification> {
  return verifyTransfer(txSignature, fromWallet, REGISTRATION_WALLET, REGISTRATION_FEE);
}

/**
 * Verify a SOL transfer between wallets
 */
export async function verifyTransfer(
  txSignature: string,
  fromWallet: string,
  toWallet: string,
  minAmount: number
): Promise<TransferVerification> {
  try {
    const url = `https://api.helius.xyz/v0/transactions/?api-key=${HELIUS_API_KEY}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: [txSignature] }),
    });

    if (!response.ok) {
      return { valid: false, error: 'Failed to fetch transaction from Helius' };
    }

    const transactions: HeliusTransaction[] = await response.json();
    const tx = transactions[0];
    
    if (!tx) {
      return { valid: false, error: 'Transaction not found' };
    }
    
    if (tx.transactionError) {
      return { valid: false, error: 'Transaction failed on chain' };
    }

    // Check native SOL transfers
    for (const transfer of tx.nativeTransfers || []) {
      if (
        transfer.fromUserAccount === fromWallet &&
        transfer.toUserAccount === toWallet &&
        transfer.amount >= minAmount * 1e9 // Convert SOL to lamports
      ) {
        return { valid: true, amount: transfer.amount / 1e9 };
      }
    }

    return { valid: false, error: 'No matching transfer found in transaction' };
  } catch (error) {
    console.error('Error verifying transfer:', error);
    return { valid: false, error: 'Failed to verify transaction' };
  }
}

/**
 * Get outgoing transactions from a wallet (for payouts list)
 */
export async function getOutgoingTransactions(walletAddress: string): Promise<Payout[]> {
  try {
    const url = `https://api.helius.xyz/v0/addresses/${walletAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=50`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      console.error('Failed to fetch transactions from Helius');
      return [];
    }

    const transactions: HeliusTransaction[] = await response.json();
    const outgoing: Payout[] = [];

    for (const tx of transactions) {
      if (tx.transactionError) continue;

      for (const transfer of tx.nativeTransfers || []) {
        if (transfer.fromUserAccount === walletAddress && transfer.amount > 0) {
          outgoing.push({
            signature: tx.signature,
            to: transfer.toUserAccount,
            amount: transfer.amount / 1e9,
            timestamp: tx.timestamp * 1000,
            status: 'confirmed',
          });
        }
      }
    }

    return outgoing;
  } catch (error) {
    console.error('Error fetching outgoing transactions:', error);
    return [];
  }
}
