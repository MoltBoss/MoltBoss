import { 
  Connection, 
  Keypair, 
  PublicKey, 
  Transaction, 
  SystemProgram, 
  sendAndConfirmTransaction 
} from '@solana/web3.js';
import bs58 from 'bs58';

const HELIUS_API_KEY = process.env.HELIUS_API_KEY!;
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY!;

// Initialize Solana connection with Helius RPC
const connection = new Connection(
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
  'confirmed'
);

// Initialize treasury keypair from private key
let treasuryKeypair: Keypair | null = null;

function getTreasuryKeypair(): Keypair {
  if (!treasuryKeypair) {
    if (!TREASURY_PRIVATE_KEY) {
      throw new Error('TREASURY_PRIVATE_KEY not configured');
    }
    treasuryKeypair = Keypair.fromSecretKey(bs58.decode(TREASURY_PRIVATE_KEY));
  }
  return treasuryKeypair;
}

export function getTreasuryPublicKey(): string {
  return getTreasuryKeypair().publicKey.toBase58();
}

interface PaymentResult {
  success: boolean;
  signature?: string;
  error?: string;
}

/**
 * Send SOL payment from treasury to a recipient wallet
 */
export async function sendPayment(toWallet: string, amountSOL: number): Promise<PaymentResult> {
  try {
    const keypair = getTreasuryKeypair();
    const recipientPubkey = new PublicKey(toWallet);
    const lamports = Math.floor(amountSOL * 1e9);

    // Create transfer instruction
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: recipientPubkey,
        lamports,
      })
    );

    // Send and confirm transaction
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [keypair],
      {
        commitment: 'confirmed',
        maxRetries: 3,
      }
    );

    console.log(`Payment sent: ${amountSOL} SOL to ${toWallet}, signature: ${signature}`);
    
    return { success: true, signature };
  } catch (error) {
    console.error('Error sending payment:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to send payment' 
    };
  }
}

/**
 * Get treasury wallet balance
 */
export async function getTreasuryBalance(): Promise<number> {
  try {
    const keypair = getTreasuryKeypair();
    const balance = await connection.getBalance(keypair.publicKey);
    return balance / 1e9; // Convert lamports to SOL
  } catch (error) {
    console.error('Error fetching treasury balance:', error);
    return 0;
  }
}

/**
 * Validate a Solana wallet address
 */
export function isValidWalletAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}
