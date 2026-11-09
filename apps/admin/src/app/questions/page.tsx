'use client';

import { useState } from 'react';
import { BUILTIN_QUESTION_DEFAULTS, QUESTION_KIND_LABEL, QUESTION_KINDS } from '@quintara/domain';
import type { ApplicationQuestions, BuiltinQuestion, CustomQuestion, QuestionKind } from '@quintara/domain';
import { Loaded, useAdmin, useLoad, useRun } from '@/lib/admin';

const hasChoices = (kind: QuestionKind) => kind === 'choice' || kind === 'multi_choice';
const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);

/** The questions on the membership application: reword the standard ones, and add questions of your own. */
export default function QuestionsPage() {
  const state = useLoad((api) => api.listApplicationQuestions());
  const [current, setCurrent] = useState<ApplicationQuestions | null>(null);
  return (
    <>
      <div>
        <h1>Application questions</h1>
        <p className="lede">What the membership application asks. Reword any standard question, or add questions of your own; they appear on a page of their own before the applicant reviews and sends. Changes apply to applications from now on.</p>
      </div>
      <Loaded state={state}>
        {(loaded) => {
          const questions = current ?? loaded;
          const custom = questions.custom.filter((q) => q.active), retired = questions.custom.filter((q) => !q.active);
          return (
            <>
              <h2>Your questions</h2>
              {custom.length === 0 ? <p className="note">No questions added yet. Applicants see only the standard questions.</p> : null}
              <div className="grid">{custom.map((q) => <CustomEditor key={q.id + q.label + q.position} question={q} onSaved={setCurrent} />)}</div>
              <NewQuestion onSaved={setCurrent} />
              {retired.length ? (
                <>
                  <h2>Retired questions</h2>
                  <p className="muted">No longer asked. Earlier answers to them stay with those applications.</p>
                  <div className="grid">{retired.map((q) => <CustomEditor key={q.id + q.label} question={q} onSaved={setCurrent} />)}</div>
                </>
              ) : null}
              <h2>Standard questions</h2>
              <p className="muted">These are always asked. You can change the wording and the help text; for interests, also the choices.</p>
              <div className="grid">{questions.builtin.map((q) => <BuiltinEditor key={q.key + q.label + q.edited} question={q} onSaved={setCurrent} />)}</div>
            </>
          );
        }}
      </Loaded>
    </>
  );
}

function BuiltinEditor({ question: q, onSaved }: { question: BuiltinQuestion; onSaved: (questions: ApplicationQuestions) => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [label, setLabel] = useState(q.label);
  const [help, setHelp] = useState(q.help);
  const [options, setOptions] = useState(q.options.join('\n'));
  const choices = q.key === 'interests';
  const changed = label.trim() !== q.label || help.trim() !== q.help || (choices && lines(options).join('\n') !== q.options.join('\n'));
  return (
    <form className="panel" aria-label={`Edit the question ${BUILTIN_QUESTION_DEFAULTS[q.key].label}`}
      onSubmit={(event) => { event.preventDefault(); void run(async () => onSaved(await api.updateBuiltinQuestion(q.key, { label, help, ...(choices ? { options: lines(options) } : {}) }))); }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong style={{ fontWeight: 500 }}>{BUILTIN_QUESTION_DEFAULTS[q.key].label}</strong>
        <span className={`chip ${q.edited ? 'gold' : ''}`}>{q.edited ? 'Reworded' : 'Standard wording'}</span>
      </div>
      <label>Question<input value={label} maxLength={160} onChange={(event) => setLabel(event.target.value)} /></label>
      <label>Help text (optional)<input value={help} maxLength={300} onChange={(event) => setHelp(event.target.value)} /></label>
      {choices ? <label>Choices, one per line<textarea rows={5} value={options} onChange={(event) => setOptions(event.target.value)} /></label> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="row">
        <button className="btn" disabled={pending || !changed}>{pending ? 'Saving' : 'Save'}</button>
        {q.edited ? <button type="button" className="btn ghost" disabled={pending} onClick={() => { if (window.confirm('Go back to the standard wording?')) void run(async () => onSaved(await api.resetBuiltinQuestion(q.key))); }}>Restore the standard wording</button> : null}
      </div>
    </form>
  );
}

function CustomEditor({ question: q, onSaved }: { question: CustomQuestion; onSaved: (questions: ApplicationQuestions) => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [label, setLabel] = useState(q.label);
  const [help, setHelp] = useState(q.help);
  const [options, setOptions] = useState(q.options.join('\n'));
  const [required, setRequired] = useState(q.required);
  const [position, setPosition] = useState(q.position);
  const save = (changes: Partial<CustomQuestion>) => run(async () => onSaved(await api.updateApplicationQuestion(q.id, changes)));
  return (
    <form className="panel" aria-label={`Edit the question ${q.label}`}
      onSubmit={(event) => { event.preventDefault(); void save({ label, help, required, position, options: hasChoices(q.kind) ? lines(options) : [] }); }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong style={{ fontWeight: 500 }}>{q.label}</strong>
        <span className="chips"><span className="chip">{QUESTION_KIND_LABEL[q.kind]}</span>{q.required ? <span className="chip gold">Required</span> : null}{q.active ? null : <span className="chip">Retired</span>}</span>
      </div>
      <label>Question<input value={label} maxLength={160} onChange={(event) => setLabel(event.target.value)} /></label>
      <label>Help text (optional)<input value={help} maxLength={300} onChange={(event) => setHelp(event.target.value)} /></label>
      {hasChoices(q.kind) ? <label>Choices, one per line<textarea rows={4} value={options} onChange={(event) => setOptions(event.target.value)} /></label> : null}
      <div className="row">
        <label className="check"><input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} /> Required</label>
        <label className="check">Order<input type="number" min={0} max={999} value={position} onChange={(event) => setPosition(Number(event.target.value))} style={{ width: 80 }} /></label>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="row">
        <button className="btn" disabled={pending}>{pending ? 'Saving' : 'Save'}</button>
        {q.active
          ? <button type="button" className="btn ghost" disabled={pending} onClick={() => { if (window.confirm(`Stop asking “${q.label}”? Answers already given are kept.`)) void save({ active: false }); }}>Retire</button>
          : <button type="button" className="btn ghost" disabled={pending} onClick={() => save({ active: true })}>Ask again</button>}
      </div>
    </form>
  );
}

function NewQuestion({ onSaved }: { onSaved: (questions: ApplicationQuestions) => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [kind, setKind] = useState<QuestionKind>('short_text');
  const [label, setLabel] = useState('');
  const [help, setHelp] = useState('');
  const [options, setOptions] = useState('');
  const [required, setRequired] = useState(false);
  return (
    <form className="panel" aria-label="Add a question" style={{ marginTop: '1rem' }}
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => onSaved(await api.createApplicationQuestion({ kind, label, help, required, options: hasChoices(kind) ? lines(options) : [] })), () => { setLabel(''); setHelp(''); setOptions(''); setRequired(false); });
      }}>
      <strong style={{ fontWeight: 500 }}>Add a question</strong>
      <div className="row">
        <label className="check">Answer<select value={kind} onChange={(event) => setKind(event.target.value as QuestionKind)}>{QUESTION_KINDS.map((k) => <option key={k} value={k}>{QUESTION_KIND_LABEL[k]}</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} /> Required</label>
      </div>
      <label>Question<input name="label" value={label} maxLength={160} onChange={(event) => setLabel(event.target.value)} placeholder="For example: Which Quintara city would you visit most?" /></label>
      <label>Help text (optional)<input value={help} maxLength={300} onChange={(event) => setHelp(event.target.value)} /></label>
      {hasChoices(kind) ? <label>Choices, one per line<textarea name="options" rows={4} value={options} onChange={(event) => setOptions(event.target.value)} /></label> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div><button className="btn" disabled={pending || label.trim().length < 2}>{pending ? 'Adding' : 'Add question'}</button></div>
    </form>
  );
}
