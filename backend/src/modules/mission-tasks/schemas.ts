import { z } from "zod";

export const createMissionTaskSchema = z.object({
  body: z.object({
    satelliteId: z.string().uuid(),
    name: z.string().min(1).max(255),
    description: z.string().optional(),
    priority: z.number().int().min(1).max(5),
    durationSeconds: z.number().int().min(1),
    deadline: z.string().datetime({ offset: true }).or(z.string().datetime()),
  }),
});

export const updateMissionTaskSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().optional(),
    priority: z.number().int().min(1).max(5).optional(),
    durationSeconds: z.number().int().min(1).optional(),
    deadline: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
    status: z.enum(["CANCELLED"]).optional(),
  }).strict(),
});

export const getMissionTaskSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});
