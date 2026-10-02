import { z } from "zod";

export const getPositionsSchema = z.object({
  query: z.object({
    time: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  }),
});
