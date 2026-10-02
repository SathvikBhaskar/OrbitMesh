import { z } from "zod";

export const getSchedulerRunSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});
