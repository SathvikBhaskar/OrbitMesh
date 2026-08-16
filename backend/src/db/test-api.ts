async function runTests() {
  console.log("Testing API Endpoints...");

  const BASE_URL = "http://localhost:4000/api";

  console.log("--- Satellites ---");
  const postSat = await fetch(`${BASE_URL}/satellites`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ noradId: 88888, name: "API SAT", status: "ACTIVE" })
  });
  const satResult = await postSat.json();
  console.log("POST:", satResult);
  
  const getSats = await fetch(`${BASE_URL}/satellites`);
  console.log("GET All count:", (await getSats.json()).length);
  
  const getSat = await fetch(`${BASE_URL}/satellites/${satResult.id}`);
  console.log("GET One:", await getSat.json());
  
  const patchSat = await fetch(`${BASE_URL}/satellites/${satResult.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "API SAT UPDATED" })
  });
  console.log("PATCH:", (await patchSat.json()).name);

  console.log("--- Ground Stations ---");
  const postGS = await fetch(`${BASE_URL}/ground-stations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "API-01", name: "API Station", latitude: 20, longitude: 30, minimumElevationDeg: 5, status: "AVAILABLE" })
  });
  const gsResult = await postGS.json();
  console.log("POST:", gsResult);

  const getGS = await fetch(`${BASE_URL}/ground-stations/${gsResult.id}`);
  console.log("GET One:", await getGS.json());

  console.log("--- Mission Tasks ---");
  const future = new Date(Date.now() + 86400000).toISOString();
  const postTask = await fetch(`${BASE_URL}/mission-tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ satelliteId: satResult.id, name: "API Task", priority: 7, durationSeconds: 500, deadline: future })
  });
  const taskResult = await postTask.json();
  console.log("POST:", taskResult);

  const patchTask = await fetch(`${BASE_URL}/mission-tasks/${taskResult.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ priority: 9 })
  });
  console.log("PATCH Priority:", (await patchTask.json()).priority);

  console.log("Done.");
}

runTests().catch(console.error);
