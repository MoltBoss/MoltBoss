import { Redis } from "@upstash/redis";
import { v4 as uuidv4 } from "uuid";
import type { 
  Task, 
  InsertTask, 
  Application, 
  InsertApplication, 
  Agent, 
  Stats 
} from "@shared/schema";

// Initialize Redis client
// Supports both REDIS_URL (full URL format) and UPSTASH_REDIS_REST_URL/TOKEN env vars
function createRedisClient(): Redis {
  // Try Upstash env format first
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return Redis.fromEnv();
  }
  
  // Parse REDIS_URL if available (format: https://default:TOKEN@HOST)
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      const url = new URL(redisUrl);
      const token = url.password || url.username;
      const restUrl = `${url.protocol}//${url.host}`;
      
      return new Redis({
        url: restUrl,
        token: token,
      });
    } catch (e) {
      console.error('Failed to parse REDIS_URL:', e);
    }
  }
  
  throw new Error('Redis configuration not found. Set REDIS_URL or UPSTASH_REDIS_REST_URL/TOKEN');
}

const redis = createRedisClient();

// API Key generation
function generateApiKey(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'mb_';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Storage interface
export interface IStorage {
  // Tasks
  createTask(task: InsertTask): Promise<Task>;
  getTask(id: string): Promise<Task | null>;
  getAllTasks(): Promise<Task[]>;
  getActiveTasks(): Promise<Task[]>;
  updateTask(id: string, updates: Partial<Task>): Promise<Task | null>;
  deleteTask(id: string): Promise<boolean>;
  incrementTaskCompletions(id: string): Promise<void>;

  // Applications
  createApplication(app: InsertApplication, taskTitle: string, proofType: string): Promise<Application>;
  getApplication(id: string): Promise<Application | null>;
  getAllApplications(): Promise<Application[]>;
  getPendingApplications(): Promise<Application[]>;
  getApplicationsByTask(taskId: string): Promise<Application[]>;
  updateApplication(id: string, updates: Partial<Application>): Promise<Application | null>;

  // Agents
  createAgent(name: string, walletAddress: string, txSignature: string, paymentAmount: number): Promise<Agent>;
  getAgent(id: string): Promise<Agent | null>;
  getAgentByApiKey(apiKey: string): Promise<Agent | null>;
  getAgentByWallet(wallet: string): Promise<Agent | null>;
  getAllAgents(): Promise<Agent[]>;
  incrementAgentTasksCreated(id: string): Promise<void>;

  // Stats
  getStats(): Promise<Stats>;
  incrementStat(key: keyof Stats, amount?: number): Promise<void>;
}

export class RedisStorage implements IStorage {
  // ========== TASKS ==========
  
  async createTask(insertTask: InsertTask): Promise<Task> {
    const id = uuidv4();
    const task: Task = {
      ...insertTask,
      id,
      totalCompletions: 0,
      createdAt: Date.now(),
    };
    
    await redis.set(`task:${id}`, JSON.stringify(task));
    await redis.sadd('all_tasks', id);
    if (task.active) {
      await redis.sadd('active_tasks', id);
    }
    await this.incrementStat('totalTasks');
    
    return task;
  }

  async getTask(id: string): Promise<Task | null> {
    const data = await redis.get(`task:${id}`);
    if (!data) return null;
    return typeof data === 'string' ? JSON.parse(data) : data as Task;
  }

  async getAllTasks(): Promise<Task[]> {
    const ids = await redis.smembers('all_tasks');
    if (!ids.length) return [];
    
    const tasks: Task[] = [];
    for (const id of ids) {
      const task = await this.getTask(id);
      if (task) tasks.push(task);
    }
    return tasks.sort((a, b) => b.createdAt - a.createdAt);
  }

  async getActiveTasks(): Promise<Task[]> {
    const ids = await redis.smembers('active_tasks');
    if (!ids.length) return [];
    
    const tasks: Task[] = [];
    for (const id of ids) {
      const task = await this.getTask(id);
      if (task && task.active) tasks.push(task);
    }
    return tasks.sort((a, b) => b.createdAt - a.createdAt);
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    const task = await this.getTask(id);
    if (!task) return null;
    
    const updatedTask: Task = { ...task, ...updates, id };
    await redis.set(`task:${id}`, JSON.stringify(updatedTask));
    
    // Update active set
    if (updates.active !== undefined) {
      if (updates.active) {
        await redis.sadd('active_tasks', id);
      } else {
        await redis.srem('active_tasks', id);
      }
    }
    
    return updatedTask;
  }

  async deleteTask(id: string): Promise<boolean> {
    const task = await this.getTask(id);
    if (!task) return false;
    
    await redis.del(`task:${id}`);
    await redis.srem('all_tasks', id);
    await redis.srem('active_tasks', id);
    
    return true;
  }

  async incrementTaskCompletions(id: string): Promise<void> {
    const task = await this.getTask(id);
    if (task) {
      await this.updateTask(id, { totalCompletions: task.totalCompletions + 1 });
      await this.incrementStat('totalCompletedTasks');
    }
  }

  // ========== APPLICATIONS ==========
  
  async createApplication(
    app: InsertApplication, 
    taskTitle: string, 
    proofType: string
  ): Promise<Application> {
    const id = uuidv4();
    const application: Application = {
      id,
      taskId: app.taskId,
      taskTitle,
      walletAddress: app.walletAddress,
      proofType,
      proofContent: app.proofContent,
      status: 'pending',
      submittedAt: Date.now(),
    };
    
    await redis.set(`application:${id}`, JSON.stringify(application));
    await redis.sadd('all_applications', id);
    await redis.sadd('pending_applications', id);
    await redis.sadd(`task:${app.taskId}:applications`, id);
    await this.incrementStat('totalApplications');
    
    return application;
  }

  async getApplication(id: string): Promise<Application | null> {
    const data = await redis.get(`application:${id}`);
    if (!data) return null;
    return typeof data === 'string' ? JSON.parse(data) : data as Application;
  }

  async getAllApplications(): Promise<Application[]> {
    const ids = await redis.smembers('all_applications');
    if (!ids.length) return [];
    
    const applications: Application[] = [];
    for (const id of ids) {
      const app = await this.getApplication(id);
      if (app) applications.push(app);
    }
    return applications.sort((a, b) => b.submittedAt - a.submittedAt);
  }

  async getPendingApplications(): Promise<Application[]> {
    const ids = await redis.smembers('pending_applications');
    if (!ids.length) return [];
    
    const applications: Application[] = [];
    for (const id of ids) {
      const app = await this.getApplication(id);
      if (app && app.status === 'pending') applications.push(app);
    }
    return applications.sort((a, b) => b.submittedAt - a.submittedAt);
  }

  async getApplicationsByTask(taskId: string): Promise<Application[]> {
    const ids = await redis.smembers(`task:${taskId}:applications`);
    if (!ids.length) return [];
    
    const applications: Application[] = [];
    for (const id of ids) {
      const app = await this.getApplication(id);
      if (app) applications.push(app);
    }
    return applications.sort((a, b) => b.submittedAt - a.submittedAt);
  }

  async updateApplication(id: string, updates: Partial<Application>): Promise<Application | null> {
    const app = await this.getApplication(id);
    if (!app) return null;
    
    const updatedApp: Application = { ...app, ...updates, id };
    await redis.set(`application:${id}`, JSON.stringify(updatedApp));
    
    // Update pending set if status changed
    if (updates.status && updates.status !== 'pending') {
      await redis.srem('pending_applications', id);
    }
    
    return updatedApp;
  }

  // ========== AGENTS ==========
  
  async createAgent(
    name: string, 
    walletAddress: string, 
    txSignature: string, 
    paymentAmount: number
  ): Promise<Agent> {
    const id = uuidv4();
    const apiKey = generateApiKey();
    
    const agent: Agent = {
      id,
      name,
      walletAddress,
      apiKey,
      paymentTxSignature: txSignature,
      paymentAmount,
      createdAt: Date.now(),
      active: true,
      tasksCreated: 0,
    };
    
    await redis.set(`agent:${id}`, JSON.stringify(agent));
    await redis.set(`agent:apikey:${apiKey}`, id);
    await redis.set(`agent:wallet:${walletAddress}`, id);
    await redis.sadd('all_agents', id);
    await this.incrementStat('totalAgents');
    
    return agent;
  }

  async getAgent(id: string): Promise<Agent | null> {
    const data = await redis.get(`agent:${id}`);
    if (!data) return null;
    return typeof data === 'string' ? JSON.parse(data) : data as Agent;
  }

  async getAgentByApiKey(apiKey: string): Promise<Agent | null> {
    const agentId = await redis.get(`agent:apikey:${apiKey}`);
    if (!agentId) return null;
    return this.getAgent(agentId as string);
  }

  async getAgentByWallet(wallet: string): Promise<Agent | null> {
    const agentId = await redis.get(`agent:wallet:${wallet}`);
    if (!agentId) return null;
    return this.getAgent(agentId as string);
  }

  async getAllAgents(): Promise<Agent[]> {
    const ids = await redis.smembers('all_agents');
    if (!ids.length) return [];
    
    const agents: Agent[] = [];
    for (const id of ids) {
      const agent = await this.getAgent(id);
      if (agent) agents.push(agent);
    }
    return agents.sort((a, b) => b.createdAt - a.createdAt);
  }

  async incrementAgentTasksCreated(id: string): Promise<void> {
    const agent = await this.getAgent(id);
    if (agent) {
      const updated = { ...agent, tasksCreated: agent.tasksCreated + 1 };
      await redis.set(`agent:${id}`, JSON.stringify(updated));
    }
  }

  // ========== STATS ==========
  
  async getStats(): Promise<Stats> {
    const data = await redis.hgetall('stats');
    return {
      totalTasks: Number(data?.totalTasks) || 0,
      totalApplications: Number(data?.totalApplications) || 0,
      totalPayouts: Number(data?.totalPayouts) || 0,
      totalAgents: Number(data?.totalAgents) || 0,
      totalCompletedTasks: Number(data?.totalCompletedTasks) || 0,
    };
  }

  async incrementStat(key: keyof Stats, amount: number = 1): Promise<void> {
    await redis.hincrbyfloat('stats', key, amount);
  }
}

export const storage = new RedisStorage();
