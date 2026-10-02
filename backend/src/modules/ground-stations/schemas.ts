import { z } from "zod";

const groundStationStatusSchema = z.enum(["AVAILABLE", "OFFLINE", "MAINTENANCE"]);

export const createGroundStationSchema = z.object({
  body: z.object({
    code: z.string().min(1).max(255),
    name: z.string().min(1).max(255),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    minimumElevationDeg: z.number().min(0).max(90),
    status: groundStationStatusSchema.optional(),
    supportedFrequencyBands: z.array(z.enum(["UHF", "S_BAND", "X_BAND", "KA_BAND", "KU_BAND"])).min(1).optional().default(["S_BAND", "X_BAND"]),
    maxConcurrentContacts: z.number().int().min(1).optional().default(1),
    maxDataRateMbps: z.number().positive().optional().default(100.0),
  }),
});

export const updateGroundStationSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    code: z.string().min(1).max(255).optional(),
    name: z.string().min(1).max(255).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    minimumElevationDeg: z.number().min(0).max(90).optional(),
    status: groundStationStatusSchema.optional(),
    supportedFrequencyBands: z.array(z.enum(["UHF", "S_BAND", "X_BAND", "KA_BAND", "KU_BAND"])).min(1).optional(),
    maxConcurrentContacts: z.number().int().min(1).optional(),
    maxDataRateMbps: z.number().positive().optional(),
  }).strict(),
});

export const getGroundStationSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});
