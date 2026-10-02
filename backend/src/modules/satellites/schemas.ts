import { z } from "zod";

const satelliteStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);

export const createSatelliteSchema = z.object({
  body: z.object({
    noradId: z.number().int().positive(),
    name: z.string().min(1).max(255),
    status: satelliteStatusSchema.optional(),
  }),
});

export const updateSatelliteSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    noradId: z.number().int().positive().optional(),
    name: z.string().min(1).max(255).optional(),
    status: satelliteStatusSchema.optional(),
  }).strict(),
});

export const getSatelliteSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const getSatellitePositionSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  query: z.object({
    at: z.string().datetime({ offset: true }).or(z.string().datetime()),
  }),
});

export const getSatelliteVisibilitySchema = z.object({
  params: z.object({
    id: z.string().uuid(),
    stationId: z.string().uuid(),
  }),
  query: z.object({
    start: z.string().datetime({ offset: true }).or(z.string().datetime()),
    end: z.string().datetime({ offset: true }).or(z.string().datetime()),
    step: z.coerce.number().int().positive(),
  }),
});
