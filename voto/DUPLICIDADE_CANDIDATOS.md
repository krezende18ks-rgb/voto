# Revisão e prevenção de candidatos duplicados

## O que foi corrigido

- O cadastro geral agora normaliza a matrícula (`trim` + maiúsculas).
- O banco passa a impedir a mesma matrícula na mesma turma/curso, mesmo com diferenças de maiúsculas/minúsculas ou espaços.
- O cadastro retorna HTTP 409 quando a matrícula já existe, em vez de criar outro registro.
- Ao iniciar uma eleição, os candidatos gerais da turma/curso são copiados para `election_candidates` dentro de uma transação.
- A cópia usa `ON CONFLICT (election_id, matric) DO NOTHING`, evitando inserir novamente um candidato que já foi incluído naquela eleição.
- A eleição só abre se houver pelo menos um candidato a líder e um a vice-líder.
- Eleições abertas/encerradas não são alteradas; o início só aceita `draft`.

## Antes de executar a migration 004

A migration não apaga duplicados automaticamente. Isso é intencional: registros com a mesma matrícula podem ter nomes/cargos diferentes, e apagar automaticamente poderia manter o cadastro errado. Rode primeiro:

```sql
SELECT
  class,
  course,
  lower(btrim(matric)) AS matricula_normalizada,
  COUNT(*) AS quantidade,
  array_agg(id ORDER BY id) AS ids,
  array_agg(name ORDER BY id) AS nomes,
  array_agg(position ORDER BY id) AS cargos
FROM candidates
GROUP BY class, course, lower(btrim(matric))
HAVING COUNT(*) > 1
ORDER BY course, class, matricula_normalizada;
```

Para conferir duplicidades já vinculadas a eleições:

```sql
SELECT
  election_id,
  lower(btrim(matric)) AS matricula_normalizada,
  COUNT(*) AS quantidade,
  array_agg(id ORDER BY id) AS ids,
  array_agg(name ORDER BY id) AS nomes,
  array_agg(position ORDER BY id) AS cargos
FROM election_candidates
GROUP BY election_id, lower(btrim(matric))
HAVING COUNT(*) > 1
ORDER BY election_id, matricula_normalizada;
```

Revise os resultados e mantenha o registro correto. **Não apague candidatos de `election_candidates` sem antes verificar se `election_ballots` os referencia**. Depois disso, execute `node migrate.js` no diretório `server`.

## Observação de segurança

O arquivo `server/.env` não deve ser versionado nem enviado em ZIP. O pacote corrigido o omite; mantenha as credenciais somente no ambiente de execução.
