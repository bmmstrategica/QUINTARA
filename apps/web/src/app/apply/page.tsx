'use client';

import Link from 'next/link';
import { Fragment, useEffect, useState } from 'react';
import { payThrough, useAction, useResource, useSession } from '@quintara/app-core';
import { follow, paymentReturnUrl } from '@/components/pay';
import { APPLICATION_PATH, APPLICATION_STATUS_LABEL, APPLICATION_STEPS, APPLICATION_WAITING_LIST_MESSAGE, BUILTIN_QUESTION_KEYS, builtinQuestion, checkAnswers, EMPTY_APPLICATION, applicationStepSchemas, formatHandle, formatMoney, RESIDENCIES, RESIDENCY_HELP, RESIDENCY_LABEL, SOCIAL_PLATFORM_LABEL, SOCIAL_PLATFORMS, termLabel } from '@quintara/domain';
import type { Application, ApplicationData, ApplicationQuestions, ApplicationStepKey, BuiltinQuestionKey, CustomQuestion, MembershipPlan, Residency, SocialPlatform } from '@quintara/domain';
import { ActionError, ResourceView } from '@/components/states';
import { useSection } from '@/components/section-copy';

const STEP_TITLES: Record<ApplicationStepKey, string> = {
  account: 'Create your account', personal: 'About you', professional: 'Your work', interests: 'Your interests', motivation: 'Why Quintara',
  referral: 'Referral or invitation', links: 'Where to find you', membership: 'Your membership', questions: 'A few more questions',
};

export default function ApplyPage() {
  const resource = useResource(async (api) => {
    const [application, plans, questions] = await Promise.all([api.getApplication(), api.listMembershipPlans(), api.getApplicationQuestions()]);
    return { application, plans, questions };
  });
  return (
    <ResourceView resource={resource}>
      {({ application, plans, questions }) =>
        application && application.status !== 'draft'
          ? <ApplicationStatusView application={application} onChanged={resource.reload} />
          : <ApplicationForm draft={application} plans={plans} questions={questions} onSubmitted={resource.reload} />
      }
    </ResourceView>
  );
}

function ApplicationForm({ draft, plans, questions, onSubmitted }: { draft: Application | null; plans: MembershipPlan[]; questions: ApplicationQuestions; onSubmitted: () => void }) {
  const { guest } = useSession();
  // A guest who applies starts with the name and email from their account.
  const [data, setData] = useState<ApplicationData>(() => {
    const start = { ...EMPTY_APPLICATION, ...(draft?.data ?? (guest ? { fullName: guest.fullName, email: guest.email } : {})) };
    return { ...start, answers: start.answers ?? {} };
  });
  // The questions step is shown only when staff have added questions.
  const steps = APPLICATION_STEPS.filter((key) => key !== 'questions' || questions.custom.length > 0);
  const reviewStep = steps.length;
  const [step, setStep] = useState(0);
  const intro = useSection('membership');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useAction((api, next: ApplicationData) => api.saveApplicationDraft(next));
  const submit = useAction((api, next: ApplicationData) => api.submitApplication(next));
  const pending = save.pending || submit.pending;
  const q = (key: BuiltinQuestionKey) => builtinQuestion(questions, key);
  const plan = plans.find((p) => p.id === data.planId) ?? null;

  // Server-side validation can still reject a field: show it and return to the first step that has one.
  useEffect(() => {
    if (submit.error?.code !== 'validation') return;
    setErrors(submit.error.fields);
    const fields = Object.keys(submit.error.fields);
    const first = steps.findIndex((key) => key === 'questions' ? fields.some((f) => f.startsWith('q:')) : Object.keys(applicationStepSchemas[key].shape).some((field) => fields.includes(field)));
    if (first >= 0) setStep(first);
  }, [submit.error]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof ApplicationData>(key: K, value: ApplicationData[K]) => setData((current) => ({ ...current, [key]: value }));
  const answer = (id: string, value: string | string[]) => setData((current) => ({ ...current, answers: { ...current.answers, [id]: value } }));

  async function next(event: React.FormEvent) {
    event.preventDefault();
    if (step === reviewStep) {
      if (await submit.run(data)) onSubmitted();
      return;
    }
    const key = steps[step];
    if (!key) return;
    const found: Record<string, string> = {};
    const result = applicationStepSchemas[key].safeParse(data);
    if (!result.success) for (const issue of result.error.issues) found[String(issue.path[0])] ??= issue.message;
    if (key === 'membership' && !found.planId && !plans.some((p) => p.id === data.planId && p.residency === data.residency)) found.planId = 'Choose the membership you are applying for';
    if (key === 'questions') for (const [id, message] of Object.entries(checkAnswers(questions.custom, data.answers).errors)) found[`q:${id}`] = message;
    if (Object.keys(found).length) { setErrors(found); return; }
    setErrors({});
    if (await save.run(data)) setStep(step + 1);
  }

  const fieldError = (key: string) => errors[key] ? <span className="field-error" id={`${key.replace(':', '-')}-error`} role="alert">{errors[key]}</span> : null;
  const describe = (key: string) => (errors[key] ? `${key.replace(':', '-')}-error` : undefined);
  const help = (text: string) => (text ? <span className="field-help">{text}</span> : null);
  const text = (key: 'email' | 'fullName' | 'phone' | 'city' | 'position' | 'company' | 'industry' | 'referral' | 'links' | 'socialHandle', question: BuiltinQuestionKey | string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => {
    const wording = typeof question === 'string' && !(BUILTIN_QUESTION_KEYS as readonly string[]).includes(question) ? { label: question, help: '' } : q(question as BuiltinQuestionKey);
    return (
      <label>
        {wording.label}
        {help(wording.help)}
        <input {...props} value={data[key]} onChange={(event) => set(key, event.target.value)} aria-invalid={errors[key] ? true : undefined} aria-describedby={describe(key)} />
        {fieldError(key)}
      </label>
    );
  };
  const current = steps[step];

  return (
    <div className="split">
      <div>
        <h2>Apply for membership</h2>
        <p className="lede" style={{ marginTop: '1rem' }}>{intro.description}</p>
        <p className="muted">Step {step + 1} of {steps.length + 1}</p>
        <progress max={steps.length + 1} value={step + 1} aria-label="Application progress" />
      </div>
      <form className="stack" onSubmit={next} noValidate>
        <h3>{current ? STEP_TITLES[current] : 'Review and send'}</h3>
        {current === 'account' ? text('email', 'email', { type: 'email', autoComplete: 'email' }) : null}
        {current === 'personal' ? <>{text('fullName', 'fullName', { autoComplete: 'name' })}{text('phone', 'phone', { type: 'tel', autoComplete: 'tel', inputMode: 'tel', placeholder: '+27 82 123 4567' })}{text('city', 'city')}</> : null}
        {current === 'professional' ? (
          <>
            <div className="field-row">{text('position', 'position')}{text('company', 'company')}</div>
            {text('industry', 'industry')}
            <fieldset>
              <legend>{q('roles').label}</legend>
              {help(q('roles').help)}
              <div className="checks">
                <label className="check"><input type="checkbox" checked={data.asFounder} onChange={(event) => set('asFounder', event.target.checked)} /> As a founder</label>
                <label className="check"><input type="checkbox" checked={data.asInvestor} onChange={(event) => set('asInvestor', event.target.checked)} /> As an investor</label>
              </div>
            </fieldset>
          </>
        ) : null}
        {current === 'interests' ? (
          <fieldset>
            <legend>{q('interests').label}</legend>
            {help(q('interests').help)}
            <div className="checks">
              {q('interests').options.map((interest) => (
                <label className="check" key={interest}>
                  <input type="checkbox" checked={data.interests.includes(interest)}
                    onChange={(event) => set('interests', event.target.checked ? [...data.interests, interest] : data.interests.filter((item) => item !== interest))} />{' '}
                  {interest}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        {current === 'motivation' ? (
          <label>
            {q('motivation').label}
            {help(q('motivation').help)}
            <textarea value={data.motivation} onChange={(event) => set('motivation', event.target.value)} aria-invalid={errors.motivation ? true : undefined} aria-describedby={describe('motivation')} />
            {fieldError('motivation')}
          </label>
        ) : null}
        {current === 'referral' ? text('referral', 'referral') : null}
        {current === 'links' ? (
          <>
            <fieldset>
              <legend>{q('social').label}</legend>
              <div className="checks" role="radiogroup" aria-label="Platform">
                {SOCIAL_PLATFORMS.map((platform) => (
                  <label className="check" key={platform}>
                    <input type="radio" name="socialPlatform" value={platform} checked={data.socialPlatform === platform} onChange={() => set('socialPlatform', platform as SocialPlatform)} /> {SOCIAL_PLATFORM_LABEL[platform]}
                  </label>
                ))}
              </div>
            </fieldset>
            {text('socialHandle', `${SOCIAL_PLATFORM_LABEL[data.socialPlatform]} handle`, { placeholder: '@yourname', autoComplete: 'off', autoCapitalize: 'none', spellCheck: false })}
            {q('social').help ? <p className="muted" style={{ margin: 0 }}>{q('social').help}</p> : null}
            {text('links', 'links', { placeholder: 'https://' })}
          </>
        ) : null}
        {current === 'membership' ? <PlanChooser plans={plans} data={data} wording={q('membership')} error={errors.planId ?? errors.residency}
          onResidency={(residency) => setData((d) => ({ ...d, residency, planId: plans.find((p) => p.id === d.planId)?.residency === residency ? d.planId : '' }))}
          onPlan={(planId) => { set('planId', planId); setErrors({}); }} /> : null}
        {current === 'questions' ? questions.custom.map((question) => (
          <CustomQuestionField key={question.id} question={question} value={data.answers[question.id]} error={errors[`q:${question.id}`]} onChange={(value) => answer(question.id, value)} />
        )) : null}
        {step === reviewStep ? (
          <>
            <dl>
              <dt>Name</dt><dd>{data.fullName}</dd>
              <dt>Email</dt><dd>{data.email}</dd>
              <dt>Phone</dt><dd>{data.phone}</dd>
              <dt>City</dt><dd>{data.city}</dd>
              <dt>Work</dt><dd>{data.position}{data.company ? `, ${data.company}` : ''}. {data.industry}</dd>
              <dt>Interests</dt><dd>{data.interests.join(', ') || 'None chosen'}</dd>
              <dt>Referral</dt><dd>{data.referral || 'None'}</dd>
              <dt>{SOCIAL_PLATFORM_LABEL[data.socialPlatform]}</dt><dd>{formatHandle(data.socialHandle)}</dd>
              <dt>Membership</dt><dd>{plan ? `${plan.name}, ${formatMoney(plan.priceMinor, plan.currency)}` : 'Not chosen'}</dd>
              {questions.custom.map((question) => {
                const value = data.answers[question.id];
                return <Fragment key={question.id}><dt>{question.label}</dt><dd>{Array.isArray(value) ? value.join(', ') || 'Not answered' : value || 'Not answered'}</dd></Fragment>;
              })}
            </dl>
            <p>{data.motivation}</p>
            <p className="muted" style={{ margin: 0 }}>Nothing is charged now. Once the membership committee approves your application, you are asked to pay.</p>
          </>
        ) : null}
        <ActionError error={save.error} />
        <ActionError error={submit.error?.code === 'validation' ? null : submit.error ?? null} />
        <div className="row">
          {step > 0 ? <button type="button" className="btn quiet" disabled={pending} onClick={() => { setErrors({}); setStep(step - 1); }}>Back</button> : null}
          <button className="btn" disabled={pending}>{pending ? 'Saving' : step === reviewStep ? 'Send application' : 'Continue'}</button>
        </div>
      </form>
    </div>
  );
}

/** Resident or international, then the term. The fee is paid only after approval. */
function PlanChooser({ plans, data, wording, error, onResidency, onPlan }: {
  plans: MembershipPlan[]; data: ApplicationData; wording: { label: string; help: string }; error?: string;
  onResidency: (residency: Residency) => void; onPlan: (id: string) => void;
}) {
  const shown = plans.filter((p) => p.residency === data.residency);
  return (
    <>
      <fieldset>
        <legend>{wording.label}</legend>
        {wording.help ? <span className="field-help">{wording.help}</span> : null}
        <div className="plans residency" role="radiogroup" aria-label="Residency">
          {RESIDENCIES.map((residency) => (
            <label key={residency} className={`plan${data.residency === residency ? ' chosen' : ''}`}>
              <input type="radio" name="residency" checked={data.residency === residency} onChange={() => onResidency(residency)} />
              <span className="name">{RESIDENCY_LABEL[residency]}</span>
              <small className="field-help">{RESIDENCY_HELP[residency]}</small>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>{RESIDENCY_LABEL[data.residency]} memberships</legend>
        {shown.length === 0 ? <p className="muted">No {RESIDENCY_LABEL[data.residency].toLowerCase()} memberships are offered in this city yet.</p> : (
          <div className="plans" role="radiogroup" aria-label={`${RESIDENCY_LABEL[data.residency]} memberships`}>
            {shown.map((p) => (
              <label key={p.id} className={`plan${data.planId === p.id ? ' chosen' : ''}`}>
                <input type="radio" name="planId" value={p.id} checked={data.planId === p.id} onChange={() => onPlan(p.id)} aria-describedby={error ? 'planId-error' : undefined} />
                <span className="term">{termLabel(p.termMonths)}</span>
                <span className="price">{formatMoney(p.priceMinor, p.currency)}</span>
              </label>
            ))}
          </div>
        )}
        {error ? <span className="field-error" id="planId-error" role="alert">{error}</span> : null}
      </fieldset>
    </>
  );
}

/** A question staff added. */
function CustomQuestionField({ question: q, value, error, onChange }: { question: CustomQuestion; value: string | string[] | undefined; error?: string; onChange: (value: string | string[]) => void }) {
  const errorId = error ? `q-${q.id}-error` : undefined;
  const label = <>{q.label}{q.required ? null : <span className="muted"> (optional)</span>}</>;
  const helpText = q.help ? <span className="field-help">{q.help}</span> : null;
  const err = error ? <span className="field-error" id={errorId} role="alert">{error}</span> : null;
  if (q.kind === 'short_text' || q.kind === 'long_text') {
    const props = { value: typeof value === 'string' ? value : '', onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value), 'aria-invalid': error ? true : undefined, 'aria-describedby': errorId };
    return <label>{label}{helpText}{q.kind === 'short_text' ? <input {...props} maxLength={200} /> : <textarea {...props} maxLength={1200} />}{err}</label>;
  }
  const options = q.kind === 'yes_no' ? ['Yes', 'No'] : q.options;
  const many = q.kind === 'multi_choice', chosen = Array.isArray(value) ? value : [];
  return (
    <fieldset aria-describedby={errorId}>
      <legend>{label}</legend>
      {helpText}
      <div className="checks" role={many ? undefined : 'radiogroup'}>
        {options.map((option) => (
          <label className="check" key={option}>
            {many
              ? <input type="checkbox" checked={chosen.includes(option)} onChange={(event) => onChange(event.target.checked ? [...chosen, option] : chosen.filter((item) => item !== option))} />
              : <input type="radio" name={`q-${q.id}`} checked={value === option} onChange={() => onChange(option)} />}{' '}
            {option}
          </label>
        ))}
      </div>
      {err}
    </fieldset>
  );
}

function ApplicationStatusView({ application, onChanged }: { application: Application; onChanged: () => void }) {
  const { refresh } = useSession();
  const pay = useAction((api) => payThrough(api, { purpose: 'membership', returnUrl: paymentReturnUrl() }, (a) => a.payMembershipFee()));
  const position = APPLICATION_PATH.indexOf(application.status);
  const messages: Partial<Record<Application['status'], string>> = {
    submitted: APPLICATION_WAITING_LIST_MESSAGE,
    under_review: `${APPLICATION_WAITING_LIST_MESSAGE} The committee is reading your application now.`,
    interview: 'The committee would like a short conversation. We will email you to arrange it.',
    approved: 'Your application has been approved. Payment details follow by email.',
    payment_pending: `Your application has been approved${application.offeredTierName ? ` for the ${application.offeredTierName} membership` : ''}. Proceed with payment to activate it.`,
    waitlisted: 'Membership is full for now. You are on the waiting list and need do nothing more.',
    declined: 'We are not able to offer membership at this time.',
    active: 'Your membership is active. Welcome to Quintara.',
  };
  return (
    <div className="split">
      <div>
        <h2>Your application</h2>
        <p className="lede" style={{ marginTop: '1rem' }}>{messages[application.status]}</p>
        <ActionError error={pay.error} />
        <div className="row">
          {application.status === 'payment_pending' ? (
            <button className="btn" disabled={pay.pending} onClick={async () => { if (follow(await pay.run())) { await refresh(); onChanged(); } }}>{pay.pending ? 'Processing' : 'Proceed with payment'}</button>
          ) : null}
          {application.status === 'active' ? <Link className="btn" href="/">Enter the club</Link> : null}
          <Link className="btn quiet" href="/experiences">See experiences open to guests</Link>
        </div>
      </div>
      <div>
        {position >= 0 ? (
          <ol className="steps">
            {APPLICATION_PATH.map((status, index) => (
              <li key={status} className={index < position ? 'done' : index === position ? 'current' : undefined} aria-current={index === position ? 'step' : undefined}>
                {APPLICATION_STATUS_LABEL[status]}
              </li>
            ))}
          </ol>
        ) : (
          <span className="tag accent">{APPLICATION_STATUS_LABEL[application.status]}</span>
        )}
      </div>
    </div>
  );
}
