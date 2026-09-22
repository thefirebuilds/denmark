import { useEffect, useRef, useState, type FormEvent } from 'react';
import '../styles/business-questions.css';

type Source = { id: string; tool: string; retrievedAt: string; filters: Record<string, unknown>; data: unknown };
type Answer = { question: string; answer: string; sources: Source[]; generatedAt: string };
const examples = ['How much did I spend on tires this year?', 'What maintenance items are due for Delavan?'];
const labels: Record<string, string> = { list_fleet: 'Fleet', search_expenses: 'Expenses', vehicle_maintenance: 'Maintenance', trip_summary: 'Trips' };

export default function BusinessQuestions() {
  const [question, setQuestion] = useState('');
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!question.trim() || busy) return;
    const submitted = question.trim();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL || ''}/api/business-questions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ question: submitted, history: answers.slice(-3).flatMap((answer) => [
          { role: 'user', content: answer.question }, { role: 'assistant', content: answer.answer },
        ]) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not answer the question.');
      if (typeof data.answer !== 'string' || !Array.isArray(data.sources)) throw new Error('The answer was incomplete. Please try again.');
      setAnswers((previous) => [...previous, { ...data, question: submitted }].slice(-6));
      setQuestion('');
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Could not answer the question.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function download(answer: Answer) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(answer, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `business-answer-${answer.generatedAt.slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <section className="business-questions" aria-labelledby="business-questions-title">
    <div className="business-questions__heading">
      <h3 id="business-questions-title">Ask about your business</h3>
      {answers.length > 0 && <button type="button" disabled={busy} onClick={() => { setAnswers([]); setError(''); }}>New conversation</button>}
    </div>
    <p className="business-questions__hint">Answers from your recorded expenses, maintenance, fleet and trips. Questions and relevant records are sent to OpenAI when you ask.</p>
    {answers.length === 0 && <div className="business-questions__examples">
      {examples.map((example) => <button type="button" key={example} disabled={busy} onClick={() => setQuestion(example)}>{example}</button>)}
    </div>}
    <div className="business-questions__answers" aria-live="polite">
      {answers.map((answer, index) => <article key={`${answer.generatedAt}-${index}`}>
        <h4>{answer.question}</h4>
        <div className="business-questions__answer">{answer.answer}</div>
        <small>As of {new Date(answer.generatedAt).toLocaleString()}</small>
        {answer.sources.length > 0 ? <details>
          <summary>Records used ({answer.sources.length})</summary>
          {answer.sources.map((source) => <details key={source.id}>
            <summary>[{source.id}] {labels[source.tool] || source.tool}</summary>
            <pre>{JSON.stringify({ filters: source.filters, data: source.data }, null, 2)}</pre>
          </details>)}
          <button type="button" onClick={() => download(answer)}>Download answer and records</button>
        </details> : <small>No database records retrieved.</small>}
      </article>)}
    </div>
    <form onSubmit={ask}>
      <label htmlFor="business-question">{answers.length ? 'Ask a follow-up' : 'Your question'}</label>
      <textarea id="business-question" value={question} maxLength={2000} rows={2} disabled={busy}
        onChange={(event) => setQuestion(event.target.value)} placeholder="What would you like to know?" />
      <button type="submit" disabled={busy || !question.trim()}>{busy ? 'Checking your records…' : 'Ask'}</button>
    </form>
    {error && <p role="alert" className="business-questions__error">{error}</p>}
  </section>;
}
