import { z } from "zod";

export const getReservationSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const previewReservationSchema = z.object({
  body: z.object({
    taskId: z.string().uuid(),
    contactWindowId: z.string().uuid(),
    startTime: z.string().datetime({ offset: true }).or(z.string().datetime()),
    endTime: z.string().datetime({ offset: true }).or(z.string().datetime()),
    locked: z.boolean().optional().default(false),
  }).refine((data) => {
    const start = new Date(data.startTime);
    const end = new Date(data.endTime);
    return end > start;
  }, {
    message: "endTime must be after startTime",
    path: ["endTime"]
  })
});

export const lockReservationSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    locked: z.boolean(),
    reason: z.string().min(1),
  })
});
