import express from "express";
import cors from "cors";
import { satellitesRouter } from "./modules/satellites/router";
import { groundStationsRouter } from "./modules/ground-stations/router";
import { missionTasksRouter } from "./modules/mission-tasks/router";
import { schedulerRouter } from "./modules/scheduler/router";
import { contactWindowsRouter } from "./modules/contact-windows/router";
import { reservationsRouter } from "./modules/reservations/router";
import { schedulerRunsRouter } from "./modules/scheduler-runs/router";

export const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "orbitmesh-api" });
});

app.use("/api/satellites", satellitesRouter);
app.use("/api/ground-stations", groundStationsRouter);
app.use("/api/mission-tasks", missionTasksRouter);
app.use("/api/contact-windows", contactWindowsRouter);
app.use("/api/reservations", reservationsRouter);
app.use("/api/scheduler-runs", schedulerRunsRouter);
app.use("/api/scheduler", schedulerRouter);

