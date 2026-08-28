import 'dotenv/config';
import { DatabaseService } from '../database/database.service';

async function main() {
  const database = new DatabaseService();
  try {
    console.table(await database.migrationStatus());
  } finally {
    await database.onModuleDestroy();
  }
}

void main().catch((error) => {
  console.error('Falha ao consultar migrations:', error);
  process.exitCode = 1;
});
