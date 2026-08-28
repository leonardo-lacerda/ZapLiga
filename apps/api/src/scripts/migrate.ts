import 'dotenv/config';
import { DatabaseService } from '../database/database.service';

async function main() {
  const database = new DatabaseService();
  try {
    await database.migrate();
    console.log('Migrations aplicadas com sucesso.');
  } finally {
    await database.onModuleDestroy();
  }
}

void main().catch((error) => {
  console.error('Falha ao aplicar migrations:', error);
  process.exitCode = 1;
});
