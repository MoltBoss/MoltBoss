import { z } from "zod";

// Task Schema
export const proofTypeSchema = z.enum(['tweet_link', 'image', 'link', 'text']);
export type ProofType = z.infer<typeof proofTypeSchema>;

export const difficultySchema = z.enum(['easy', 'medium', 'hard']);
export type Difficulty = z.infer<typeof difficultySchema>;

export const taskSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().min(1),
  instructions: z.string().min(1),
  proofType: proofTypeSchema,
  reward: z.number().positive(),
  difficulty: difficultySchema,
  category: z.string().min(1),
  active: z.boolean().default(true),
  totalCompletions: z.number().int().nonnegative().default(0),
  maxCompletions: z.number().int().positive().optional(),
  createdAt: z.number(),
});

export type Task = z.infer<typeof taskSchema>;

export const insertTaskSchema = taskSchema.omit({ 
  id: true, 
  totalCompletions: true, 
  createdAt: true 
});
export type InsertTask = z.infer<typeof insertTaskSchema>;

// Application Schema
export const applicationStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type ApplicationStatus = z.infer<typeof applicationStatusSchema>;

export const applicationSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  walletAddress: z.string().min(32).max(44),
  proofType: z.string(),
  proofContent: z.string().min(1),
  status: applicationStatusSchema.default('pending'),
  submittedAt: z.number(),
  reviewedAt: z.number().optional(),
  paidAt: z.number().optional(),
  txSignature: z.string().optional(),
});

export type Application = z.infer<typeof applicationSchema>;

export const insertApplicationSchema = z.object({
  taskId: z.string(),
  walletAddress: z.string().min(32).max(44),
  proofContent: z.string().min(1),
});
export type InsertApplication = z.infer<typeof insertApplicationSchema>;

// Agent Schema
export const agentSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  walletAddress: z.string().min(32).max(44),
  apiKey: z.string(),
  paymentTxSignature: z.string(),
  paymentAmount: z.number().positive(),
  createdAt: z.number(),
  active: z.boolean().default(true),
  tasksCreated: z.number().int().nonnegative().default(0),
});

export type Agent = z.infer<typeof agentSchema>;

export const registerAgentSchema = z.object({
  name: z.string().min(1),
  wallet: z.string().min(32).max(44),
  txSignature: z.string().min(1),
});
export type RegisterAgent = z.infer<typeof registerAgentSchema>;

// Platform Stats Schema
export const statsSchema = z.object({
  totalTasks: z.number().int().nonnegative().default(0),
  totalApplications: z.number().int().nonnegative().default(0),
  totalPayouts: z.number().nonnegative().default(0),
  totalAgents: z.number().int().nonnegative().default(0),
  totalCompletedTasks: z.number().int().nonnegative().default(0),
});

export type Stats = z.infer<typeof statsSchema>;

// Payout Transaction Schema
export const payoutSchema = z.object({
  signature: z.string(),
  to: z.string(),
  amount: z.number(),
  timestamp: z.number(),
  status: z.string(),
});

export type Payout = z.infer<typeof payoutSchema>;
