import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import path from "path";
import fs from "fs";
import { storage } from "./storage";
import { verifyRegistrationPayment, getOutgoingTransactions } from "./services/helius";
import { sendPayment, getTreasuryPublicKey, isValidWalletAddress } from "./services/solana";
import { 
  insertTaskSchema, 
  insertApplicationSchema, 
  registerAgentSchema,
  type Agent 
} from "@shared/schema";

// Environment variables
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Moremore16";
const TREASURY_WALLET = process.env.TREASURY_WALLET || "PXpVKE42sXTnAqRqbKidaTKgCrkgexFrSNQXdxppJZR";

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer configuration for file uploads
const fileStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: fileStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (_req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'));
    }
  }
});

// Extend Express Request to include agent
declare global {
  namespace Express {
    interface Request {
      agent?: Agent;
    }
  }
}

// Middleware: Admin authentication
function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const password = req.headers['x-admin-password'] as string;
  if (password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Unauthorized: Invalid admin password' });
    return;
  }
  next();
}

// Middleware: Agent API key authentication
async function agentAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.headers['x-api-key'] as string;
  if (!apiKey) {
    res.status(401).json({ error: 'Unauthorized: API key required' });
    return;
  }
  
  const agent = await storage.getAgentByApiKey(apiKey);
  if (!agent) {
    res.status(401).json({ error: 'Unauthorized: Invalid API key' });
    return;
  }
  
  if (!agent.active) {
    res.status(403).json({ error: 'Forbidden: Agent account is inactive' });
    return;
  }
  
  req.agent = agent;
  next();
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // ========== PUBLIC ROUTES ==========
  
  // GET /api/tasks - List all active tasks
  app.get('/api/tasks', async (_req: Request, res: Response) => {
    try {
      const tasks = await storage.getActiveTasks();
      res.json(tasks);
    } catch (error) {
      console.error('Error fetching tasks:', error);
      res.status(500).json({ error: 'Failed to fetch tasks' });
    }
  });

  // GET /api/tasks/:id - Get task details
  app.get('/api/tasks/:id', async (req: Request, res: Response) => {
    try {
      const taskId = req.params.id as string;
      const task = await storage.getTask(taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      res.json(task);
    } catch (error) {
      console.error('Error fetching task:', error);
      res.status(500).json({ error: 'Failed to fetch task' });
    }
  });

  // GET /api/stats - Get platform statistics
  app.get('/api/stats', async (_req: Request, res: Response) => {
    try {
      const stats = await storage.getStats();
      res.json(stats);
    } catch (error) {
      console.error('Error fetching stats:', error);
      res.status(500).json({ error: 'Failed to fetch statistics' });
    }
  });

  // GET /api/payouts - Get outgoing transactions from treasury
  app.get('/api/payouts', async (_req: Request, res: Response) => {
    try {
      const payouts = await getOutgoingTransactions(TREASURY_WALLET);
      res.json(payouts);
    } catch (error) {
      console.error('Error fetching payouts:', error);
      res.status(500).json({ error: 'Failed to fetch payouts' });
    }
  });

  // POST /api/applications - Submit task application
  app.post('/api/applications', async (req: Request, res: Response) => {
    try {
      const parsed = insertApplicationSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request', details: parsed.error.errors });
      }

      const { taskId, walletAddress, proofContent } = parsed.data;

      // Validate wallet address
      if (!isValidWalletAddress(walletAddress)) {
        return res.status(400).json({ error: 'Invalid Solana wallet address' });
      }

      // Check task exists and is active
      const task = await storage.getTask(taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      if (!task.active) {
        return res.status(400).json({ error: 'Task is no longer active' });
      }

      // Check slots available
      if (task.maxCompletions && task.totalCompletions >= task.maxCompletions) {
        return res.status(400).json({ error: 'No slots available for this task' });
      }

      const application = await storage.createApplication(parsed.data, task.title, task.proofType);
      res.status(201).json(application);
    } catch (error) {
      console.error('Error creating application:', error);
      res.status(500).json({ error: 'Failed to submit application' });
    }
  });

  // POST /api/upload - Upload proof image
  app.post('/api/upload', upload.single('file'), (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }
      
      const fileUrl = `/uploads/${req.file.filename}`;
      res.json({ 
        success: true, 
        url: fileUrl,
        filename: req.file.filename 
      });
    } catch (error) {
      console.error('Error uploading file:', error);
      res.status(500).json({ error: 'Failed to upload file' });
    }
  });

  // ========== AGENT ROUTES ==========
  
  // POST /api/agent/register - Register new agent
  app.post('/api/agent/register', async (req: Request, res: Response) => {
    try {
      const parsed = registerAgentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request', details: parsed.error.errors });
      }

      const { name, wallet, txSignature } = parsed.data;

      // Validate wallet address
      if (!isValidWalletAddress(wallet)) {
        return res.status(400).json({ error: 'Invalid Solana wallet address' });
      }

      // Check if wallet already registered
      const existingAgent = await storage.getAgentByWallet(wallet);
      if (existingAgent) {
        return res.status(400).json({ error: 'Wallet already registered as an agent' });
      }

      // Verify payment transaction
      const verification = await verifyRegistrationPayment(txSignature, wallet);
      if (!verification.valid) {
        return res.status(400).json({ 
          error: 'Payment verification failed', 
          details: verification.error 
        });
      }

      // Create agent
      const agent = await storage.createAgent(name, wallet, txSignature, verification.amount!);
      
      res.status(201).json({
        success: true,
        agent: {
          id: agent.id,
          name: agent.name,
          walletAddress: agent.walletAddress,
          apiKey: agent.apiKey,
          createdAt: agent.createdAt,
        },
        message: 'Agent registered successfully. Save your API key securely!'
      });
    } catch (error) {
      console.error('Error registering agent:', error);
      res.status(500).json({ error: 'Failed to register agent' });
    }
  });

  // GET /api/agent/tasks - List tasks (requires API key)
  app.get('/api/agent/tasks', agentAuth, async (_req: Request, res: Response) => {
    try {
      const tasks = await storage.getActiveTasks();
      res.json(tasks);
    } catch (error) {
      console.error('Error fetching agent tasks:', error);
      res.status(500).json({ error: 'Failed to fetch tasks' });
    }
  });

  // POST /api/agent/tasks - Create new task (requires API key)
  app.post('/api/agent/tasks', agentAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertTaskSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request', details: parsed.error.errors });
      }

      const task = await storage.createTask(parsed.data);
      
      // Increment agent's tasks created count
      if (req.agent) {
        await storage.incrementAgentTasksCreated(req.agent.id);
      }

      res.status(201).json(task);
    } catch (error) {
      console.error('Error creating task:', error);
      res.status(500).json({ error: 'Failed to create task' });
    }
  });

  // GET /api/agent/tasks/:id - Get task by ID (requires API key)
  app.get('/api/agent/tasks/:id', agentAuth, async (req: Request, res: Response) => {
    try {
      const taskId = req.params.id as string;
      const task = await storage.getTask(taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      res.json(task);
    } catch (error) {
      console.error('Error fetching task:', error);
      res.status(500).json({ error: 'Failed to fetch task' });
    }
  });

  // POST /api/agent/apply - Apply for task (requires API key)
  app.post('/api/agent/apply', agentAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertApplicationSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request', details: parsed.error.errors });
      }

      const { taskId, walletAddress, proofContent } = parsed.data;

      // Validate wallet address
      if (!isValidWalletAddress(walletAddress)) {
        return res.status(400).json({ error: 'Invalid Solana wallet address' });
      }

      // Check task exists and is active
      const task = await storage.getTask(taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      if (!task.active) {
        return res.status(400).json({ error: 'Task is no longer active' });
      }

      // Check slots available
      if (task.maxCompletions && task.totalCompletions >= task.maxCompletions) {
        return res.status(400).json({ error: 'No slots available for this task' });
      }

      const application = await storage.createApplication(parsed.data, task.title, task.proofType);
      res.status(201).json(application);
    } catch (error) {
      console.error('Error creating application:', error);
      res.status(500).json({ error: 'Failed to submit application' });
    }
  });

  // ========== ADMIN ROUTES ==========
  
  // GET /api/admin/tasks - List all tasks
  app.get('/api/admin/tasks', adminAuth, async (_req: Request, res: Response) => {
    try {
      const tasks = await storage.getAllTasks();
      res.json(tasks);
    } catch (error) {
      console.error('Error fetching admin tasks:', error);
      res.status(500).json({ error: 'Failed to fetch tasks' });
    }
  });

  // POST /api/admin/tasks - Create task
  app.post('/api/admin/tasks', adminAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertTaskSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request', details: parsed.error.errors });
      }

      const task = await storage.createTask(parsed.data);
      res.status(201).json(task);
    } catch (error) {
      console.error('Error creating task:', error);
      res.status(500).json({ error: 'Failed to create task' });
    }
  });

  // PUT /api/admin/tasks/:id - Update task
  app.put('/api/admin/tasks/:id', adminAuth, async (req: Request, res: Response) => {
    try {
      const taskId = req.params.id as string;
      const task = await storage.getTask(taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }

      const updatedTask = await storage.updateTask(taskId, req.body);
      res.json(updatedTask);
    } catch (error) {
      console.error('Error updating task:', error);
      res.status(500).json({ error: 'Failed to update task' });
    }
  });

  // DELETE /api/admin/tasks/:id - Delete task
  app.delete('/api/admin/tasks/:id', adminAuth, async (req: Request, res: Response) => {
    try {
      const taskId = req.params.id as string;
      const deleted = await storage.deleteTask(taskId);
      if (!deleted) {
        return res.status(404).json({ error: 'Task not found' });
      }
      res.json({ success: true, message: 'Task deleted' });
    } catch (error) {
      console.error('Error deleting task:', error);
      res.status(500).json({ error: 'Failed to delete task' });
    }
  });

  // GET /api/admin/applications - List all applications
  app.get('/api/admin/applications', adminAuth, async (_req: Request, res: Response) => {
    try {
      const applications = await storage.getAllApplications();
      res.json(applications);
    } catch (error) {
      console.error('Error fetching applications:', error);
      res.status(500).json({ error: 'Failed to fetch applications' });
    }
  });

  // PUT /api/admin/applications/:id - Approve/reject application
  app.put('/api/admin/applications/:id', adminAuth, async (req: Request, res: Response) => {
    try {
      const applicationId = req.params.id as string;
      const { status } = req.body;
      
      if (!status || !['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status. Must be "approved" or "rejected"' });
      }

      const application = await storage.getApplication(applicationId);
      if (!application) {
        return res.status(404).json({ error: 'Application not found' });
      }

      if (application.status !== 'pending') {
        return res.status(400).json({ error: 'Application has already been reviewed' });
      }

      const updates: any = {
        status,
        reviewedAt: Date.now(),
      };

      // If approved, send payment
      if (status === 'approved') {
        const task = await storage.getTask(application.taskId);
        if (!task) {
          return res.status(404).json({ error: 'Associated task not found' });
        }

        // Send SOL payment
        const paymentResult = await sendPayment(application.walletAddress, task.reward);
        
        if (!paymentResult.success) {
          return res.status(500).json({ 
            error: 'Failed to send payment', 
            details: paymentResult.error 
          });
        }

        updates.txSignature = paymentResult.signature;
        updates.paidAt = Date.now();

        // Update task completions and stats
        await storage.incrementTaskCompletions(application.taskId);
        await storage.incrementStat('totalPayouts', task.reward);
      }

      const updatedApplication = await storage.updateApplication(applicationId, updates);
      res.json(updatedApplication);
    } catch (error) {
      console.error('Error updating application:', error);
      res.status(500).json({ error: 'Failed to update application' });
    }
  });

  // GET /api/admin/agents - List registered agents
  app.get('/api/admin/agents', adminAuth, async (_req: Request, res: Response) => {
    try {
      const agents = await storage.getAllAgents();
      // Remove sensitive API keys from response
      const safeAgents = agents.map(agent => ({
        ...agent,
        apiKey: agent.apiKey.substring(0, 10) + '...',
      }));
      res.json(safeAgents);
    } catch (error) {
      console.error('Error fetching agents:', error);
      res.status(500).json({ error: 'Failed to fetch agents' });
    }
  });

  // Serve uploaded files
  app.use('/uploads', (req, res, next) => {
    const filePath = path.join(uploadsDir, req.path);
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).json({ error: 'File not found' });
    }
  });

  return httpServer;
}
