import express from "express";
import { OrbitalSyncWorker } from "../modules/orbital-data/services/orbital-sync-worker";
import { OrbitalSyncService } from "../modules/orbital-data/services/orbital-sync-service";
import { OrbitalDataIngestionService } from "../modules/orbital-data/services/ingestion-service";
import { IncrementalContactWindowService } from "../modules/contact-windows/incremental-contact-window-service";
import { ContactWindowService } from "../modules/contact-windows/contact-window-service";
import { OrbitalDataProvider, NewSatellite, NewGroundStation, NewSatelliteOrbitalData } from "../modules/data-providers/orbital-data-provider";

class MockProvider implements OrbitalDataProvider {
  public sats: NewSatellite[] = [];
  public data: NewSatelliteOrbitalData[] = [];
  public shouldFail = false;
  public getSatsCallCount = 0;
  
  async getSatellites(): Promise<NewSatellite[]> {
    this.getSatsCallCount++;
    if (this.shouldFail) throw new Error("CelesTrak timeout");
    return this.sats;
  }
  
  async getGroundStations(): Promise<NewGroundStation[]> {
    return [];
  }
  
  async getOrbitalData(satelliteIds: string[]): Promise<NewSatelliteOrbitalData[]> {
    if (this.shouldFail) throw new Error("CelesTrak timeout");
    return this.data.map((d, i) => ({...d, satelliteId: satelliteIds[i]}));
  }
}

async function runTests() {
  console.log("=== ORBITAL SYNC API & WORKER TESTS ===\n");
  
  const mockProvider = new MockProvider();
  const ingestionService = new OrbitalDataIngestionService(mockProvider);
  const incrementalService = new IncrementalContactWindowService(new ContactWindowService());
  const syncService = new OrbitalSyncService(mockProvider, ingestionService, incrementalService);
  
  // Create mock API router
  const router = express.Router();
  router.post("/", async (req, res) => {
    try {
      const result = await syncService.sync();
      if (result.status === "SKIPPED_ALREADY_RUNNING") {
        res.json({ status: "SKIPPED", reason: "SYNC_ALREADY_RUNNING" });
        return;
      }
      if (result.status === "FAILED") {
        res.status(500).json({ status: "FAILED", reason: result.error });
        return;
      }
      res.json({
        status: "SUCCESS",
        fetchedCount: result.report?.fetchedCount
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const app = express();
  app.use("/api/orbital-sync", router);

  // Helper for requests
  const requestSync = async () => {
    return new Promise<any>((resolve) => {
      const req = { method: "POST", url: "/" } as any;
      const res = {
        status: (code: number) => res,
        json: (data: any) => resolve(data)
      } as any;
      router.handle(req, res, () => resolve(null));
    });
  };

  // --- Test 1: Manual Invocation ---
  console.log("Test 1: Manual API Invocation");
  const res1 = await requestSync();
  console.log(`API Status: ${res1.status} (Expected SUCCESS)`);
  console.log("Result: " + (res1.status === "SUCCESS" ? "PASS" : "FAIL") + "\n");

  // --- Test 2: Provider Failure ---
  console.log("Test 2: Provider Failure via API");
  mockProvider.shouldFail = true;
  const res2 = await requestSync();
  console.log(`API Status: ${res2.status} (Expected FAILED)`);
  console.log(`Reason: ${res2.reason}`);
  console.log("Result: " + (res2.status === "FAILED" && res2.reason === "CelesTrak timeout" ? "PASS" : "FAIL") + "\n");
  mockProvider.shouldFail = false;

  // --- Test 3: Concurrent Execution (API level) ---
  console.log("Test 3: Concurrent Execution");
  const oldGet = mockProvider.getSatellites.bind(mockProvider);
  mockProvider.getSatellites = async () => {
    await new Promise(r => setTimeout(r, 100));
    return oldGet();
  };
  
  const [res3a, res3b] = await Promise.all([requestSync(), requestSync()]);
  const statuses = [res3a.status, res3b.status];
  console.log(`Statuses: ${statuses.join(", ")}`);
  const hasSkipped = statuses.includes("SKIPPED");
  const hasSuccess = statuses.includes("SUCCESS");
  console.log("Result: " + (hasSkipped && hasSuccess ? "PASS" : "FAIL") + "\n");

  // --- Test 4: Disabled Worker ---
  console.log("Test 4: Disabled Worker (interval <= 0)");
  mockProvider.getSatellites = oldGet;
  const startCount = mockProvider.getSatsCallCount;
  
  const workerDisabled = new OrbitalSyncWorker(syncService, 0);
  workerDisabled.start();
  await new Promise(r => setTimeout(r, 50));
  const endCount = mockProvider.getSatsCallCount;
  
  console.log(`Calls before/after: ${startCount} / ${endCount} (Expected to be equal)`);
  console.log("Result: " + (startCount === endCount ? "PASS" : "FAIL") + "\n");

  // --- Test 5: Enabled Periodic Execution ---
  console.log("Test 5: Enabled Periodic Execution");
  const workerEnabled = new OrbitalSyncWorker(syncService, 0.1); // 100ms
  const currentCount = mockProvider.getSatsCallCount;
  workerEnabled.start();
  
  await new Promise(r => setTimeout(r, 250)); // Should tick ~2 times
  workerEnabled.stop();
  
  const finalCount = mockProvider.getSatsCallCount;
  const ticked = finalCount > currentCount;
  console.log(`Calls before/after: ${currentCount} / ${finalCount}`);
  console.log("Result: " + (ticked ? "PASS" : "FAIL") + "\n");

  process.exit(0);
}

runTests().catch(e => {
  console.error(e);
  process.exit(1);
});
