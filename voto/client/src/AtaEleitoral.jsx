import React, { useEffect, useState } from 'react';
import './AtaEleitoral.css';

const AtaEleitoral = ({ electionId }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/elections/${electionId}/ata-data`, {
      headers: { 'Authorization': `Bearer ${sessionStorage.getItem('token')}` }
    })
      .then(res => res.json())
      .then(setData)
      .finally(() => setLoading(false));
  }, [electionId]);

  if (loading) return <div>Carregando ata...</div>;
  if (!data) return <div>Erro ao carregar dados.</div>;

  const { election, results, participation, candidates } = data;

  const candidateMap = Object.fromEntries((candidates || []).map(c => [c.id, c.name]));

  return (
    <div className="ata-container">
      <div className="print-controls">
        <button onClick={() => window.print()} className="btn-print">Imprimir Ata (2 Páginas A4)</button>
      </div>

      <header className="ata-header">
        <h1>SISTEMA CLASSVOTE — ATA DE APURAÇÃO E ELEIÇÃO</h1>
        <p><strong>Curso:</strong> {election.course} | <strong>Turma:</strong> {election.class} | <strong>Período:</strong> {election.period}</p>
        <p><strong>Início:</strong> {election.started_at ? new Date(election.started_at).toLocaleString('pt-BR') : 'N/A'} | <strong>Encerramento:</strong> {election.ended_at ? new Date(election.ended_at).toLocaleString('pt-BR') : 'Em andamento'}</p>
      </header>

      <section className="ata-section">
        <h2>1. Resumo da Apuração de Votos</h2>
        <table>
          <thead>
            <tr>
              <th>Cargo</th>
              <th>Candidato</th>
              <th>Total de Votos</th>
            </tr>
          </thead>
          <tbody>
            {results && results.length > 0 ? (
              results.map((res, i) => (
                <tr key={i}>
                  <td>{res.pos === 'leader' ? 'Líder de Turma' : 'Vice-Líder'}</td>
                  <td>{candidateMap[res.cid] || res.cid}</td>
                  <td>{res.total}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan="3" style={{ textAlign: 'center' }}>Nenhum voto registrado para esta eleição.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <div className="page-break"></div>

      <section className="ata-section">
        <h2>2. Lista de Presença e Participação</h2>
        <p>Total de eleitores que votaram: <strong>{participation.length}</strong></p>
        <table className="lista-presenca">
          <thead>
            <tr>
              <th style={{ width: '10%' }}>#</th>
              <th style={{ width: '50%' }}>Nome do Eleitor</th>
              <th style={{ width: '40%' }}>Assinatura</th>
            </tr>
          </thead>
          <tbody>
            {participation && participation.length > 0 ? (
              participation.map((p, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{p.name} ({p.matric})</td>
                  <td className="assinatura-cell"></td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan="3" style={{ textAlign: 'center' }}>Nenhuma participação registrada.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <footer className="ata-footer">
        <p>Ata gerada eletronicamente pelo ClassVote em {new Date().toLocaleString('pt-BR')}.</p>
        <div className="assinaturas">
          <div className="assinatura-box">
            <div className="linha-assinatura"></div>
            <p>Presidente da Mesa / Coordenador</p>
          </div>
          <div className="assinatura-box">
            <div className="linha-assinatura"></div>
            <p>Secretário(a) / Professor(a)</p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default AtaEleitoral;
