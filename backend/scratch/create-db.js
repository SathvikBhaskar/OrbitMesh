const { Client } = require('pg');

async function createDb() {
  const client = new Client({ connectionString: 'postgresql://orbitmesh:your_secure_password_here@localhost:5432/postgres' });
  await client.connect();
  try {
    await client.query('CREATE DATABASE orbitmesh_lab');
    console.log("Database created");
  } catch (e) {
    if (e.code === '42P04') console.log("Database already exists");
    else console.error(e);
  } finally {
    await client.end();
  }
}
createDb();
