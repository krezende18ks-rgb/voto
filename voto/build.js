import { build } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runBuild() {
  try {
    console.log('Iniciando build do cliente...');
    await build({
      root: path.join(__dirname, 'client'),
      build: {
        outDir: path.join(__dirname, 'votação-dist'),
        emptyOutDir: true,
      }
    });
    console.log('✅ Build concluído com sucesso!');
  } catch (err) {
    console.error('❌ Erro no build:', err);
  }
}

runBuild();
