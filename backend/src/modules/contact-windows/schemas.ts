import { z } from "zod";

export const generateContactWindowsSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
    stationId: z.string().uuid(),
  }),
  body: z.object({
    start: z.string().datetime({ offset: true }).or(z.string().datetime()),
    end: z.string().datetime({ offset: true }).or(z.string().datetime()),
    stepSeconds: z.number().int().min(1).max(3600),
  }),
});
