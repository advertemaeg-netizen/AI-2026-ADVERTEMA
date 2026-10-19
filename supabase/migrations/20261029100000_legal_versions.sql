-- ============================================================
-- The legal pages, versioned (2026-10-20).
--
-- A legal document's job is to answer "what did this say on the day that
-- customer signed up?". So every save is a NEW row, never an edit: the table
-- is append-only (the trigger below refuses UPDATE and DELETE for everyone,
-- service role included), and a version's id is what an account's acceptance
-- points at (users.accepted_*_version_id).
--
-- Two documents (privacy, terms), each in two languages, each language its own
-- history: the Arabic and English texts are written as two texts, not one
-- translated from the other, and either can change alone.
--
-- Read: anyone, the published columns only (the public site renders them,
-- with the publishable key, at build time and on revalidation). created_by
-- (an internal user id) and note (an internal change note) are not granted
-- to anon or authenticated; super admins read them through
-- admin_legal_versions().
-- Write: only through publish_legal_version(), which checks is_super_admin()
-- and numbers the version under a per-document lock.
-- ============================================================

create table public.legal_versions (
  id         uuid primary key default gen_random_uuid(),
  document   text not null check (document in ('privacy', 'terms')),
  locale     text not null check (locale in ('ar', 'en')),
  version    int  not null check (version >= 1),
  title      text not null check (length(trim(title)) > 0),
  body       text not null check (length(trim(body)) > 0),
  note       text,
  created_at timestamptz not null default now(),
  -- Null only for version 1, imported from the repository's drafts by this
  -- migration, which no user saved
  created_by uuid references public.users(id),
  unique (document, locale, version),
  check (created_by is not null or version = 1)
);

comment on table public.legal_versions is
  'Append-only: every save of a legal document is a new version. Never updated or deleted (trigger legal_versions_append_only).';

-- Append-only, for everyone: no grant can make an UPDATE or a DELETE succeed
create or replace function public.legal_versions_refuse_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'legal_versions is append-only: % is not allowed; publish a new version instead', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger legal_versions_append_only
  before update or delete on public.legal_versions
  for each row execute function public.legal_versions_refuse_change();

-- TRUNCATE bypasses row triggers: refuse it too
create trigger legal_versions_no_truncate
  before truncate on public.legal_versions
  for each statement execute function public.legal_versions_refuse_change();

alter table public.legal_versions enable row level security;

revoke all on public.legal_versions from public, anon, authenticated;
-- Anonymous visitors read published text only: column-level grant, this table only
grant select (id, document, locale, version, title, body, created_at)
  on public.legal_versions to anon, authenticated;

create policy legal_versions_read on public.legal_versions
  for select to anon, authenticated using (true);

-- The one way to write: a super admin publishes the next version of one
-- document in one language. The advisory lock serialises two saves of the
-- same document and language, so they can't take the same number.
create or replace function public.publish_legal_version(
  p_document text,
  p_locale text,
  p_title text,
  p_body text,
  p_note text default null
)
returns public.legal_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  next_version int;
  saved public.legal_versions;
begin
  if not public.is_super_admin() then
    raise exception 'only a super admin can publish a legal document'
      using errcode = 'insufficient_privilege';
  end if;

  perform pg_advisory_xact_lock(hashtext('legal_versions:' || p_document || ':' || p_locale));

  select coalesce(max(version), 0) + 1 into next_version
  from public.legal_versions
  where document = p_document and locale = p_locale;

  insert into public.legal_versions (document, locale, version, title, body, note, created_by)
  values (p_document, p_locale, next_version, p_title, p_body, nullif(trim(p_note), ''), auth.uid())
  returning * into saved;

  return saved;
end;
$$;

revoke execute on function public.publish_legal_version(text, text, text, text, text) from public, anon;
grant execute on function public.publish_legal_version(text, text, text, text, text) to authenticated;

-- Every column, who saved it included: for the super admins' editor
create or replace function public.admin_legal_versions()
returns table (
  id uuid,
  document text,
  locale text,
  version int,
  title text,
  body text,
  note text,
  created_at timestamptz,
  created_by uuid,
  created_by_email text
)
language sql
stable
security definer
set search_path = public
as $$
  select v.id, v.document, v.locale, v.version, v.title, v.body, v.note, v.created_at, v.created_by, u.email
  from public.legal_versions v
  left join public.users u on u.id = v.created_by
  where public.is_super_admin()
  order by v.document, v.locale, v.version desc
$$;

revoke execute on function public.admin_legal_versions() from public, anon;
grant execute on function public.admin_legal_versions() to authenticated;

-- ------------------------------------------------------------
-- Acceptance at signup: the versions the person ticked "I agree" to.
--
-- The signup form sends the ids of the versions it showed (user metadata
-- accepted_legal: {terms, privacy}). Recorded when the profile row is
-- created, only if each id is a version of the right document, and never
-- changed afterwards. Off until the legal pages are relinked after the
-- lawyer (SITE_LEGAL_LINKED): until then the form sends nothing and nothing
-- is recorded.
-- ------------------------------------------------------------

alter table public.users
  add column accepted_terms_version_id   uuid references public.legal_versions(id),
  add column accepted_privacy_version_id uuid references public.legal_versions(id),
  add column legal_accepted_at           timestamptz;

create or replace function public.record_legal_acceptance()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  accepted jsonb;
  terms_id uuid;
  privacy_id uuid;
begin
  if tg_op = 'UPDATE' then
    if new.accepted_terms_version_id is distinct from old.accepted_terms_version_id
       or new.accepted_privacy_version_id is distinct from old.accepted_privacy_version_id
       or new.legal_accepted_at is distinct from old.legal_accepted_at then
      raise exception 'a recorded acceptance of the legal documents cannot be changed'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- INSERT: only what the signup form sent, never what the row was given
  new.accepted_terms_version_id := null;
  new.accepted_privacy_version_id := null;
  new.legal_accepted_at := null;

  select raw_user_meta_data -> 'accepted_legal' into accepted from auth.users where id = new.id;
  if accepted is null then
    return new;
  end if;

  begin
    terms_id := (accepted ->> 'terms')::uuid;
    privacy_id := (accepted ->> 'privacy')::uuid;
  exception when invalid_text_representation then
    return new;
  end;

  -- Both, or neither: an acceptance is of the two documents together
  if exists (select 1 from public.legal_versions where id = terms_id and document = 'terms')
     and exists (select 1 from public.legal_versions where id = privacy_id and document = 'privacy') then
    new.accepted_terms_version_id := terms_id;
    new.accepted_privacy_version_id := privacy_id;
    new.legal_accepted_at := now();
  end if;
  return new;
end;
$$;

revoke execute on function public.record_legal_acceptance() from public, anon, authenticated;

create trigger users_record_legal_acceptance
  before insert or update on public.users
  for each row execute function public.record_legal_acceptance();

-- ------------------------------------------------------------
-- Version 1: the drafts as they stand in messages/site/{ar,en}.json,
-- generated by script (title; each section as "## heading" then its body).
-- Placeholders and all: this is the pre-review text, and the pages stay
-- unlinked until the lawyer's version replaces it.
-- ------------------------------------------------------------

insert into public.legal_versions (document, locale, version, title, body, note)
values
  ('privacy', 'ar', 1, $legal$سياسة الخصوصية$legal$, $legal$## 1. من نحن

مُدرك منتج تابع لـ [[اسم الكيان]]، سجل تجاري رقم [[الرقم]]، وعنوانها [[العنوان]].
للتواصل بخصوص البيانات الشخصية: [[بريد مسؤول حماية البيانات]].

## 2. دورنا في بياناتك

لنا دوران مختلفان، ومن المهم التفريق بينهما:

- **عندما تكون أنت عميلنا** — أي صاحب حساب على مُدرك — فنحن نتحكم في بيانات حسابك
  ونحدد كيف تُستخدم.
- **عندما يتحدث عملاؤك أنت مع البوت** — فنحن نعالج بياناتهم نيابة عنك وبتعليماتك.
  أنت المسؤول عن تلك البيانات، ونحن ننفذ ما تطلبه. ما يحكم هذه العلاقة هو اتفاقية
  معالجة البيانات المرفقة بشروط الخدمة.

## 3. البيانات التي نجمعها

**بيانات حسابك:** الاسم، البريد الإلكتروني، رقم الهاتف، اسم النشاط، بيانات الاشتراك.

**محتوى المحادثات:** نصوص الرسائل المتبادلة بين البوت وعملائك، وما يرد فيها من
أسماء وأرقام هواتف ومواعيد وخدمات مطلوبة.

**المعلومات التي تدخلها أنت:** قاعدة المعرفة الخاصة بنشاطك — المواعيد والفروع
والخدمات والأسعار وغيرها.

**بيانات تقنية:** عنوان IP، نوع المتصفح والجهاز، أوقات الاستخدام، وسجلات الأخطاء.

## 4. البيانات الحساسة

قد تتضمن المحادثات بيانات حساسة بطبيعتها. على سبيل المثال، إذا كان نشاطك عيادة،
فقد يذكر المريض حالته الصحية أو الخدمة الطبية التي يطلبها.

هذه البيانات تخضع لحماية مشددة بموجب القانون. ولأنك أنت من يجمعها من عملائك عبر
البوت، فإن الحصول على موافقتهم الكتابية على جمعها ومعالجتها التزام يقع عليك أنت،
لا علينا. نحن نعالجها بتعليماتك وحدها، ولا نستخدمها لأي غرض آخر.

## 5. لماذا نستخدم بياناتك

- لتشغيل الخدمة: الرد على رسائل عملائك، حجز المواعيد، وتسجيل بيانات من تواصل معك.
- لإدارة حسابك واشتراكك.
- لتحسين الخدمة وإصلاح الأعطال.
- للتواصل معك بشأن الخدمة.
- للالتزام بما يفرضه القانون.

لا نبيع بياناتك ولا بيانات عملائك لأي جهة. ولا نستخدم محتوى محادثاتك لتدريب نماذج
ذكاء اصطناعي عامة.

## 6. من يطّلع على البيانات

نستعين بمزودي خدمات لتشغيل مُدرك، ولا يطّلعون على البيانات إلا بالقدر اللازم لعملهم:

- **استضافة وقواعد البيانات:** [[اسم المزود]] — تخزين البيانات.
- **مزودو نماذج الذكاء الاصطناعي:** [[اسم المزود]] — توليد الردود.
- **منصات المراسلة:** واتساب وفيسبوك وإنستجرام، بحسب القنوات التي توصّلها، وتخضع
  لسياسات الخصوصية الخاصة بها.
- **خدمات الدفع:** [[اسم المزود]].

## 7. نقل البيانات خارج مصر

بعض مزودي الخدمات المذكورين أعلاه يشغّلون خوادمهم خارج مصر، ما يعني أن البيانات
تُعالج وتُخزّن خارج البلاد.

نتعامل مع هذا النقل وفق ما يفرضه قانون حماية البيانات الشخصية رقم 151 لسنة 2020
ولائحته التنفيذية، ونلزم مزودي الخدمات تعاقديًا بمستوى حماية لا يقل عما يقرره
القانون المصري.

[[ملاحظة للمراجعة القانونية: هذا القسم يصف الواقع ولا يدّعي الحصول على تصريح نقل
خارج الحدود. لا يُضاف أي ادعاء بذلك قبل صدور التصريح فعليًا.]]

## 8. مدة الاحتفاظ

نحتفظ ببيانات حسابك طوال سريان الاشتراك، وبمحتوى المحادثات وبيانات العملاء المحتملين
لمدة [[المدة]] من تاريخ المحادثة، ما لم تطلب حذفها قبل ذلك.

عند إنهاء حسابك، تُحذف البيانات خلال [[المدة]]، فيما عدا ما يلزمنا القانون
بالاحتفاظ به، وما يخص الفواتير والسجلات المالية.

## 9. حقوقك

لك، ولعملائك فيما يخص بياناتهم، الحقوق التالية:

- معرفة البيانات المحفوظة عنك والحصول على نسخة منها.
- تصحيح أي بيانات غير صحيحة.
- طلب حذف بياناتك.
- سحب موافقتك في أي وقت.
- الاعتراض على معالجة بياناتك أو تقييدها.

لممارسة أي من هذه الحقوق، راسلنا على [[البريد]]. نرد خلال [[المدة]].

إذا كنت عميلًا لأحد مستخدمي مُدرك وتريد ممارسة حقوقك على بياناتك، فتوجّه إلى النشاط
الذي تحدثت معه مباشرة، لأنه هو المتحكم في بياناتك. ويمكنك مراسلتنا وسنوجّه طلبك إليه.

## 10. أمان البيانات

نستخدم التشفير أثناء النقل والتخزين، ونفصل بيانات كل عميل عن غيره على مستوى قاعدة
البيانات، ونقصر الوصول على من يحتاجه لعمله. ومع ذلك، لا يمكن لأي نظام أن يضمن
أمانًا مطلقًا.

في حال وقوع اختراق يمس بياناتك، نخطرك ونخطر الجهة المختصة وفق ما يفرضه القانون.

## 11. الأطفال

مُدرك غير موجّه لمن هم دون 18 عامًا، ولا نجمع بياناتهم عن قصد. إذا علمنا بجمع
بيانات لقاصر دون موافقة ولي أمره، نحذفها.

## 12. ملفات تعريف الارتباط

نستخدم ملفات تعريف الارتباط الضرورية لتشغيل الموقع وتسجيل الدخول، وملفات لقياس
الاستخدام. يمكنك التحكم فيها من إعدادات متصفحك. [[يُستكمل عند تحديد أدوات القياس.]]

## 13. تعديل هذه السياسة

قد نعدّل هذه السياسة. وعند إجراء تعديل جوهري، نخطرك عبر البريد الإلكتروني أو داخل
المنصة قبل سريانه.

## 14. التواصل والشكاوى

للاستفسارات أو الشكاوى: [[البريد]].

ولك الحق في تقديم شكوى إلى مركز حماية البيانات الشخصية في مصر إذا رأيت أننا لم
نلتزم بالقانون.$legal$, 'Imported from the drafts in messages/site (the pre-review text, placeholders included).'),
  ('terms', 'ar', 1, $legal$شروط الخدمة$legal$, $legal$## 1. الأطراف وقبول الشروط

هذه الشروط اتفاق بينك وبين [[اسم الكيان]] بشأن استخدامك لمنصة مُدرك. باستخدامك
للخدمة أو إنشائك حسابًا عليها، فإنك تقبل هذه الشروط. إن كنت تستخدمها نيابة عن
شركة أو نشاط، فأنت تقر بأنك مخوّل بذلك.

## 2. الخدمة

مُدرك منصة ترد على رسائل عملائك عبر واتساب وفيسبوك وإنستجرام وموقعك، اعتمادًا على
المعلومات التي تدخلها أنت، وتحجز المواعيد وتسجّل بيانات من تواصل معك.

نطوّر الخدمة باستمرار، وقد نضيف أو نعدّل أو نوقف مزايا. وإن أوقفنا ميزة جوهرية
تعتمد عليها، نخطرك قبل ذلك بوقت معقول.

## 3. حسابك

أنت مسؤول عن سرية بيانات دخولك وعن كل ما يحدث عبر حسابك. أخطرنا فورًا عند أي
استخدام غير مصرح به.

تلتزم بأن تكون البيانات التي تقدمها عند التسجيل صحيحة وحديثة.

## 4. استخدام الخدمة

تلتزم بألا تستخدم مُدرك في:

- مخالفة القانون، أو انتهاك حقوق الغير.
- إرسال رسائل دعائية لمن لم يوافق على تلقيها.
- انتحال صفة شخص أو جهة أخرى، أو تقديم البوت على أنه إنسان إذا سأل العميل صراحة.
- محاولة اختراق المنصة أو تعطيلها أو الوصول إلى بيانات عملاء آخرين.
- إعادة بيع الخدمة أو إتاحتها للغير دون اتفاق مكتوب معنا.

وتلتزم كذلك بشروط المنصات التي توصّلها، وعلى رأسها شروط واتساب للأعمال وشروط ميتا.
مخالفتك لها قد تؤدي إلى إيقاف قناتك من جانب تلك المنصات، ولا نتحمل مسؤولية ذلك.

## 5. بيانات عملائك ومسؤوليتك عنها

عندما يتحدث عملاؤك مع البوت، فأنت المتحكم في بياناتهم ونحن المعالج الذي ينفذ
تعليماتك. ويترتب على ذلك:

- أنت المسؤول عن إبلاغ عملائك بأن محادثاتهم تُسجّل وتُعالج، وعن الحصول على موافقتهم.
- إذا كانت المحادثات قد تتضمن بيانات حساسة — كالبيانات الصحية في حالة العيادات —
  فأنت المسؤول عن الحصول على موافقة كتابية صريحة منهم، وفق ما يفرضه القانون.
- أنت المسؤول عن مشروعية أي بيانات ترفعها إلى المنصة.
- أنت المسؤول عن الرد على طلبات عملائك المتعلقة ببياناتهم، ونساعدك في تنفيذها.

تفاصيل هذه العلاقة تحكمها اتفاقية معالجة البيانات المرفقة، وهي جزء لا يتجزأ من
هذه الشروط.

## 6. حدود ما يفعله البوت

البوت يولّد ردودًا اعتمادًا على المعلومات التي تدخلها، وقد يخطئ أو يسيء الفهم.

**ردود البوت ليست استشارة مهنية.** وهي ليست استشارة طبية ولا قانونية ولا مالية،
ولا يجوز تقديمها على أنها كذلك. إذا كان نشاطك طبيًا، فأنت مسؤول عن ضبط ما يقوله
البوت وعن تحويل ما يستلزم رأي مختص إلى مختص.

نحن لا نراجع محتوى الردود قبل إرسالها، وأنت المسؤول عما يقوله البوت باسم نشاطك.

## 7. المواعيد

عندما يؤكد البوت موعدًا، فهو يسجّله لديك بناءً على الإعدادات والمواعيد التي حددتها
أنت. والالتزام بالموعد أمام العميل يقع عليك وحدك.

لا نضمن توافر الموعد في جدولك الفعلي، ولا نتحمل مسؤولية موعد لم يُحترم.

## 8. الاشتراك والدفع

تُحدد الباقات وأسعارها على موقعنا أو في عرض السعر المرسل إليك. الاشتراك [[شهري /
سنوي]] ويُجدد تلقائيًا ما لم تلغه قبل [[المدة]] من تاريخ التجديد.

رسوم التأسيس، إن وُجدت، تُدفع مرة واحدة وغير قابلة للاسترداد بعد بدء العمل.

قد نعدّل الأسعار، ونخطرك قبل سريان التعديل بـ [[المدة]].

## 9. الإيقاف والإنهاء

يمكنك إنهاء اشتراكك في أي وقت من داخل المنصة، ويسري الإنهاء في نهاية الدورة الجارية.

يحق لنا إيقاف حسابك أو إنهاؤه إذا خالفت هذه الشروط، أو تأخرت في السداد، أو استُخدم
حسابك بما يضر المنصة أو غيرك. ونخطرك قبل ذلك ما لم تكن المخالفة جسيمة أو مستمرة.

بعد الإنهاء، يمكنك طلب نسخة من بياناتك خلال [[المدة]].

## 10. الملكية الفكرية

المنصة وبرمجياتها وعلامتها التجارية ملك لنا. ولا يمنحك هذا الاتفاق أي حق فيها عدا
حق استخدام الخدمة طوال الاشتراك.

أما المعلومات التي ترفعها ومحتوى محادثاتك، فتظل ملكك أنت.

## 11. حدود المسؤولية

نقدّم الخدمة بالحالة المتاحة، ولا نضمن أن تعمل دون انقطاع أو خطأ.

لا نتحمل المسؤولية عن الأرباح الفائتة أو الفرص الضائعة أو الأضرار غير المباشرة.
وفي كل الأحوال، لا تتجاوز مسؤوليتنا الإجمالية قيمة ما سددته خلال [[المدة]] السابقة
على واقعة المطالبة.

لا يسري هذا الحد على ما لا يجوز قانونًا الحد منه.

## 12. التعويض

تلتزم بتعويضنا عن أي مطالبة توجَّه إلينا بسبب مخالفتك لهذه الشروط، أو بسبب محتوى
رفعته، أو بسبب استخدامك للخدمة في مخالفة للقانون أو لشروط منصات المراسلة.

## 13. القانون الحاكم

تخضع هذه الشروط للقانون المصري، وتختص محاكم [[المحكمة]] بأي نزاع ينشأ عنها.

## 14. تعديل الشروط

قد نعدّل هذه الشروط، ونخطرك قبل سريان أي تعديل جوهري بـ [[المدة]]. واستمرارك في
استخدام الخدمة بعد سريانه يُعد قبولًا له.

## 15. التواصل

[[البريد الإلكتروني]] — [[العنوان]]$legal$, 'Imported from the drafts in messages/site (the pre-review text, placeholders included).'),
  ('privacy', 'en', 1, $legal$Privacy Policy$legal$, $legal$## 1. Who we are

Mudrik is a product of [[entity name]], commercial register [[number]], registered at
[[address]]. For anything concerning personal data: [[DPO email]].

## 2. Our two roles

We hold two different roles and the difference matters:

- **When you are our customer** — an account holder on Mudrik — we control your account
  data and decide how it is used.
- **When your own customers talk to the bot** — we process their data on your behalf and
  on your instructions. You are responsible for that data; we carry out what you ask.
  That relationship is governed by the data processing agreement attached to the Terms.

## 3. What we collect

**Account data:** name, email, phone number, business name, subscription details.

**Conversation content:** the messages exchanged between the bot and your customers,
including any names, phone numbers, appointments and requested services in them.

**What you enter:** your knowledge base — hours, branches, services, prices and so on.

**Technical data:** IP address, browser and device type, usage times, error logs.

## 4. Sensitive data

Conversations may contain data that is sensitive by nature. If your business is a
clinic, for example, a patient may mention their condition or the medical service they
want.

Such data carries heightened protection under the law. Because it is you who collects it
from your customers through the bot, obtaining their written consent to collect and
process it is your obligation, not ours. We process it only on your instructions and use
it for nothing else.

## 5. Why we use it

- To run the service: answering your customers, booking appointments, and recording who
  contacted you.
- To manage your account and subscription.
- To improve the service and fix faults.
- To contact you about the service.
- To meet legal obligations.

We do not sell your data or your customers' data to anyone. We do not use your
conversation content to train general-purpose AI models.

## 6. Who sees the data

We rely on service providers to run Mudrik. They see only what their work requires:

- **Hosting and database:** [[provider]] — data storage.
- **AI model providers:** [[provider]] — generating replies.
- **Messaging platforms:** WhatsApp, Facebook and Instagram, depending on the channels
  you connect, each under its own privacy policy.
- **Payments:** [[provider]].

## 7. Transfers outside Egypt

Some of the providers above run their servers outside Egypt, which means data is
processed and stored abroad.

We handle these transfers in line with Personal Data Protection Law No. 151 of 2020 and
its Executive Regulations, and we bind our providers contractually to a level of
protection no lower than Egyptian law requires.

[[Note for legal review: this section describes the position and does NOT claim a
cross-border transfer permit has been obtained. Do not add such a claim until one has.]]

## 8. How long we keep it

We keep your account data for as long as your subscription runs. We keep conversation
content and lead data for [[period]] from the date of the conversation, unless you ask
us to delete it sooner.

When your account closes, data is deleted within [[period]], except what the law
requires us to keep and what relates to invoices and financial records.

## 9. Your rights

You, and your customers in respect of their own data, have the right to:

- know what data we hold and receive a copy of it;
- have incorrect data corrected;
- ask for your data to be deleted;
- withdraw consent at any time;
- object to or restrict processing.

To exercise any of these, write to [[email]]. We respond within [[period]].

If you are a customer of a business that uses Mudrik and want to exercise your rights,
contact that business directly — it controls your data. You may also write to us and we
will pass your request on to them.

## 10. Security

We encrypt data in transit and at rest, separate each customer's data from every other
customer's at the database level, and limit access to those who need it for their work.
No system can promise absolute security.

If a breach affects your data, we will notify you and the competent authority as the law
requires.

## 11. Children

Mudrik is not aimed at anyone under 18 and we do not knowingly collect their data. If we
learn we hold a minor's data without a guardian's consent, we delete it.

## 12. Cookies

We use cookies that are necessary to run the site and keep you signed in, and cookies
that measure usage. You can control them in your browser settings. [[To be completed once
the analytics tools are decided.]]

## 13. Changes to this policy

We may amend this policy. Where an amendment is material, we will tell you by email or
inside the platform before it takes effect.

## 14. Contact and complaints

Questions or complaints: [[email]].

You also have the right to complain to Egypt's Personal Data Protection Centre if you
believe we have not met our obligations.$legal$, 'Imported from the drafts in messages/site (the pre-review text, placeholders included).'),
  ('terms', 'en', 1, $legal$Terms of Service$legal$, $legal$## 1. The parties and acceptance

These Terms are an agreement between you and [[entity name]] about your use of the
Mudrik platform. By using the service or creating an account you accept them. If you are
using it on behalf of a company or business, you confirm you are authorised to do so.

## 2. The service

Mudrik answers your customers' messages on WhatsApp, Facebook, Instagram and your
website, based on the information you provide, books appointments and records who
contacted you.

We develop the service continuously and may add, change or discontinue features. If we
discontinue a material feature you rely on, we will give you reasonable notice first.

## 3. Your account

You are responsible for keeping your credentials confidential and for everything that
happens through your account. Tell us immediately about any unauthorised use.

You agree that the information you give us on registration is accurate and current.

## 4. Acceptable use

You agree not to use Mudrik to:

- break the law or infringe anyone's rights;
- send marketing messages to people who have not agreed to receive them;
- impersonate another person or organisation, or present the bot as a human when a
  customer asks directly;
- attempt to breach, disrupt, or access other customers' data;
- resell the service or make it available to third parties without a written agreement
  with us.

You also agree to the terms of the platforms you connect, in particular the WhatsApp
Business and Meta terms. Breaching those may get your channel suspended by them, and we
are not responsible for that.

## 5. Your customers' data and your responsibility for it

When your customers talk to the bot, you are the controller of their data and we are the
processor acting on your instructions. It follows that:

- You are responsible for telling your customers that their conversations are recorded
  and processed, and for obtaining their consent.
- Where conversations may contain sensitive data — health data in the case of a clinic,
  for example — you are responsible for obtaining their explicit written consent as the
  law requires.
- You are responsible for the lawfulness of any data you upload to the platform.
- You are responsible for responding to your customers' requests about their own data,
  and we will help you carry them out.

The detail of this relationship is governed by the attached data processing agreement,
which forms part of these Terms.

## 6. The limits of what the bot does

The bot generates replies from the information you provide. It can be wrong or
misunderstand.

**The bot's replies are not professional advice.** They are not medical, legal or
financial advice and must not be presented as such. If your business is a medical one,
you are responsible for controlling what the bot says and for routing anything that
needs a professional opinion to a professional.

We do not review the content of replies before they are sent, and you are responsible for
what the bot says in your business's name.

## 7. Appointments

When the bot confirms an appointment, it records it for you based on the settings and
hours you configured. Honouring that appointment with the customer is yours alone.

We do not guarantee the slot is free in your actual calendar, and we are not responsible
for an appointment that is not kept.

## 8. Subscription and payment

Plans and their prices are set out on our site or in the quote sent to you. The
subscription is [[monthly / annual]] and renews automatically unless cancelled [[period]]
before the renewal date.

Setup fees, where they apply, are payable once and are non-refundable after work begins.

We may change prices and will give you [[period]] notice before a change takes effect.

## 9. Suspension and termination

You may end your subscription at any time from inside the platform; it takes effect at
the end of the current cycle.

We may suspend or close your account if you breach these Terms, fall behind on payment,
or if your account is used in a way that harms the platform or others. We will warn you
first unless the breach is serious or ongoing.

After termination you may request a copy of your data within [[period]].

## 10. Intellectual property

The platform, its software and its brand are ours. This agreement gives you no rights in
them beyond the right to use the service for the term of your subscription.

The information you upload and your conversation content remain yours.

## 11. Limitation of liability

The service is provided as available, and we do not promise it will run without
interruption or error.

We are not liable for lost profits, lost opportunities or indirect damages. In any event
our total liability will not exceed what you paid in the [[period]] before the event
giving rise to the claim.

This limit does not apply to anything that cannot lawfully be limited.

## 12. Indemnity

You agree to indemnify us against any claim brought against us because of your breach of
these Terms, because of content you uploaded, or because of your use of the service in
breach of the law or of the messaging platforms' terms.

## 13. Governing law

These Terms are governed by Egyptian law, and the courts of [[court]] have jurisdiction
over any dispute arising from them.

## 14. Changes to these Terms

We may amend these Terms and will give you [[period]] notice of any material change.
Continuing to use the service after it takes effect is acceptance of it.

## 15. Contact

[[email]] — [[address]]$legal$, 'Imported from the drafts in messages/site (the pre-review text, placeholders included).');
