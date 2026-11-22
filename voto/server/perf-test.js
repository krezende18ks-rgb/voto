const db = require('./db');

const ITERATIONS = Math.max(10, Number(process.env.PERF_ITERATIONS || 100));
const CONCURRENCY = Math.max(1, Number(process.env.PERF_CONCURRENCY || 10));

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

async function benchmark(label, sql, params = []) {
  // Aquecimento: reduz a influência da primeira execução.
  for (let i = 0; i < 5; i++) await db.query(sql, params);

  const samples = [];
  const started = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = process.hrtime.bigint();
    await db.query(sql, params);
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  // Carga concorrente separada; não confundir latência sequencial com throughput.
  const concurrentStarted = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i += CONCURRENCY) {
    const batch = Math.min(CONCURRENCY, ITERATIONS - i);
    await Promise.all(Array.from({ length: batch }, () => db.query(sql, params)));
  }
  const concurrentElapsedMs = Number(process.hrtime.bigint() - concurrentStarted) / 1e6;

  return {
    consulta: label,
    iteracoes: ITERATIONS,
    media_ms: Number((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2)),
    p50_ms: Number(percentile(samples, 50).toFixed(2)),
    p95_ms: Number(percentile(samples, 95).toFixed(2)),
    max_ms: Number(Math.max(...samples).toFixed(2)),
    throughput_sequencial_req_s: Number((ITERATIONS / (elapsedMs / 1000)).toFixed(2)),
    throughput_concorrente_req_s: Number((ITERATIONS / (concurrentElapsedMs / 1000)).toFixed(2))
  };
}

async function main() {
  console.log('=== TESTE DE DESEMPENHO DO CLASSVOTE ===');
  console.log(`Iterações: ${ITERATIONS} | Concorrência: ${CONCURRENCY}`);
  const tests = [
    ['contagem de usuários', 'SELECT COUNT(*) FROM users'],
    ['usuários da turma A', 'SELECT COUNT(*) FROM users WHERE class = $1', ['A']],
    ['candidatos da turma A', 'SELECT COUNT(*) FROM candidates WHERE class = $1', ['A']],
    ['participação da turma A', 'SELECT COUNT(*) FROM voter_participation WHERE voter_class = $1', ['A']],
    ['cédulas da turma A', 'SELECT COUNT(*) FROM ballots WHERE voter_class = $1', ['A']],
    ['total de blocos', 'SELECT COUNT(*) FROM blockchain']
  ];

  const results = [];
  for (const [label, sql, params = []] of tests) {
    results.push(await benchmark(label, sql, params));
  }
  console.table(results);
  console.log('Observação: os resultados medem consultas ao banco neste ambiente; não representam, isoladamente, a capacidade total de usuários simultâneos do sistema.');
}

main()
  .catch((err) => {
    console.error('Falha no teste de desempenho:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await db.end?.(); } catch {}
  });
