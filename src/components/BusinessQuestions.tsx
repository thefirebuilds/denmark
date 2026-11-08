import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import '../styles/business-questions.css';

type Source = { id: string; tool: string; retrievedAt: string; filters: Record<string, unknown>; data: unknown };
type Answer = { question: string; answer: string; sources: Source[]; generatedAt: string; lookupFailures?: { tool: string; code: string; error: string; view?: string }[] };
const examples = ['How much did I spend on tires this year?', 'What maintenance items are due for Delavan?', 'Add a todo to fix the headlights on Geneva'];
const labels: Record<string, string> = { database_schema: 'Database schema', database_query: 'Database query', list_fleet: 'Fleet', search_expenses: 'Expenses', vehicle_maintenance: 'Maintenance', trip_summary: 'Trips', search_trips: 'Trip records and return times', search_guest_messages: 'Guest messages', create_maintenance_task: 'Created maintenance to-do' };
const MINIMIZED_KEY = 'denmark.businessQuestions.minimized';

export default function BusinessQuestions({ initialQuestion = '', embedded = false, telemetryTripId }: { initialQuestion?: string; embedded?: boolean; telemetryTripId?: number }) {
  const id = useId();
  const [minimized, setMinimized] = useState(() => {
    try { return embedded ? false : localStorage.getItem(MINIMIZED_KEY) === 'true'; }
    catch { return false; }
  });
  useEffect(() => {
    if (embedded) return;
    try { localStorage.setItem(MINIMIZED_KEY, String(minimized)); }
    catch { /* The panel still works when browser storage is unavailable. */ }
  }, [minimized, embedded]);
  const [question, setQuestion] = useState(initialQuestion);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function ask(event?: FormEvent) {
    event?.preventDefault();
    if (!question.trim() || busy) return;
    const submitted = question.trim();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL || ''}/api/business-questions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ question: submitted, telemetry_trip_id: telemetryTripId, history: answers.slice(-3).flatMap((answer) => [
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

  const QuestionContainer = embedded ? 'div' : 'form';
  return <section className="business-questions" aria-labelledby={`${id}-title`}>
    <div className="business-questions__heading">
      <h3 id={`${id}-title`}>{embedded ? 'Ask AI about this trip' : 'Ask about your business'}</h3>
      <button type="button" aria-expanded={!minimized} aria-controls={`${id}-content`}
        onClick={() => setMinimized((value) => !value)}>{minimized ? 'Expand' : 'Minimize'}</button>
    </div>
    <div id={`${id}-content`} hidden={minimized}>
    {answers.length > 0 && <button type="button" disabled={busy} onClick={() => { setAnswers([]); setError(''); }}>New conversation</button>}
    <p className="business-questions__hint">{embedded ? 'Review stored trip telemetry for possible incident or driving-behavior indicators. Edit the prompt before asking. ' : 'Ask about your expenses, maintenance, fleet and trips, or ask to add a vehicle maintenance to-do. '}Requests and relevant records are sent to OpenAI.</p>
    {answers.length === 0 && !embedded && <div className="business-questions__examples">
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
        </details> : <small>{answer.lookupFailures?.length ? 'No successful database lookups. See the lookup failure above.' : 'No database records retrieved.'}</small>}
      </article>)}
    </div>
    <QuestionContainer className="business-questions__composer" onSubmit={embedded ? undefined : ask}>
      <label htmlFor={`${id}-question`}>{answers.length ? 'Ask a follow-up' : 'Your question'}</label>
      <textarea id={`${id}-question`} value={question} maxLength={2000} rows={embedded ? 5 : 2} disabled={busy}
        onKeyDown={embedded ? (event) => event.stopPropagation() : undefined}
        onChange={(event) => setQuestion(event.target.value)} placeholder="Ask a question or add a maintenance to-do" />
      <button type={embedded ? 'button' : 'submit'} onClick={embedded ? () => { void ask(); } : undefined} disabled={busy || !question.trim()}>{busy ? 'Checking your records…' : 'Ask'}</button>
    </QuestionContainer>
    {error && <p role="alert" className="business-questions__error">{error}</p>}
    </div>
  </section>;
}
