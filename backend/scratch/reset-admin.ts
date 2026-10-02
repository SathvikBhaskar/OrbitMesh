import { db } from './src/db/client';
import { users } from './src/db/schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

async function resetAdminPassword() {
  const all = await db.select().from(users);
  console.log('Users in DB:');
  for (const u of all) {
    console.log(`  ${u.email} (role: ${u.role}, id: ${u.id})`);
  }

  const hash = await bcrypt.hash('admin123', 10);
  const result = await db.update(users)
    .set({ passwordHash: hash })
    .where(eq(users.email, 'admin@orbitmesh.com'))
    .returning();
  
  if (result.length > 0) {
    console.log(`\n✅ Password reset for admin@orbitmesh.com`);
  } else {
    console.log('\n❌ No user found with that email — creating...');
    const [newUser] = await db.insert(users).values({
      email: 'admin@orbitmesh.com',
      passwordHash: hash,
      role: 'ADMIN',
    }).returning();
    console.log(`✅ Created admin user: ${newUser.email}`);
  }
  process.exit(0);
}

resetAdminPassword().catch(err => { console.error(err); process.exit(1); });
