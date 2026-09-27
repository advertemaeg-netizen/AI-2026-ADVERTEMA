# تقرير الفحص الشامل قبل الإطلاق

**التاريخ:** 2026-09-27
**النطاق:** قاعدة البيانات (19 migration)، الصلاحيات، حدود الاشتراكات، الأمان، الأخطاء، الترجمات، الأداء.
**الحالة:** كل المشاكل الحرجة والمهمة اتصلّحت، ومعاها التحسينات I2 و I3 و I4 و I8 بعد المراجعة. باقي التحسينات متسابة في آخر التقرير.

## الملخص

| التصنيف | العدد | الحالة |
|---|---|---|
| حرجة | 1 | اتصلّحت |
| مهمة | 7 | اتصلّحت |
| تحسين | 15 | 5 اتصلّحوا (I2 و I3 و I4 و I8 بعد المراجعة، و I15 لأنه كان سطرين)، والباقي في التقرير |

**التحقق:**
- الـ 19 migration، ومعاهم الـ migration الجديدة، اتشغّلوا بالترتيب على PGlite ومرّوا كلهم.
- اختبار الـ RLS لكل دور اتعمل باستعلامات حقيقية تحت `set role authenticated` مع `auth.uid()` لكل مستخدم، بنفس الـ default grants بتاعة Supabase.
- `npm run build` نجح، و`eslint .` و`tsc --noEmit` على المشروع كله نضاف.
- I2 عليه 5 اختبارات (`node --test`) بتشغّل `detectLead` الحقيقية بـ Supabase مزيّف وبتراقب `fetch`. الاختبارات بتفشل لو الفحص اتشال، وبتنجح وهو موجود. ومعاها اختبار على PGlite بيأكد إن `check_client_limit` بترجع `inactive` في كل حالات الاشتراك غير النشط لما تتنادى بالـ service role.
- I8 اتجرب على السيرفر الفعلي: route handlers و server actions و server components اللي بتنادي `getSession` كلها اشتغلت صح (401 JSON للي مش مسجل دخول، و200 للصفحات العامة).
- I3 عليه 8 اختبارات (`node --test`) بتشغّل `testBot` الحقيقية مع stubs للـ session والـ bot والـ admin client، وبتفشل 6 منهم لو الإصلاح اتشال. ومعاها اختبار على PGlite بيأكد إن `check_client_limit` بترجع حالة لجلسة الـ client_admin، وإن `consume_client_message` مقفولة على `authenticated` وبتزوّد العداد مع الـ service role.
- I4 عليه 13 اختبار على PGlite، وبيفشل 6 منهم من غير الـ migration: الإضافة المباشرة، النقل لعميل ممتلئ، الـ client_admin، العدادات بعد النقل، تغيير الدور في `accept_invite` عند الحد، إنشاء عميل، والاشتراك غير النشط.
- صفحة 404 اتجربت على السيرفر الفعلي بالعربي والإنجليزي.

---

## الإصلاحات

### حرجة

#### C1. الـ team_member (وأي عضو في العميل) يقدر يقرأ tokens القنوات
- **المكان:** `supabase/migrations/20260924090333_rls_policies.sql:125` (policy اسمها "Users see channels of their clients")
- **المشكلة:** الـ policy بتسمح لأي حد عنده `has_client_access` إنه يقرأ كل أعمدة `channels`، ومنها `credentials` اللي فيها tokens المنصات. الـ team_member يقدر يعمل `select credentials from channels` من الـ API مباشرة بالـ JWT بتاعه. **الاختبار أكّدها:** رجع `{"token":"SECRET"}`.
- **الإصلاح:** في `supabase/migrations/20261008100000_launch_audit_fixes.sql` §1 اتعمل `revoke select` على الجدول، وبعدها `grant select` على كل الأعمدة ماعدا `credentials`. التطبيق أصلاً مش بيقرا العمود ده من الـ API، والـ webhook بيستخدم service role فمش متأثر.
- **ملاحظة للمستقبل:** أي عمود جديد يتضاف لـ `channels` لازم يتضاف للـ grant ده، وإلا الـ select عليه هيرجع `permission denied`.

### مهمة

#### M1. الـ team_member يقدر يمسح leads من الـ API
- **المكان:** `supabase/migrations/20260924090333_rls_policies.sql:181` (policy "Users manage leads of their clients" من نوع `FOR ALL`)
- **المشكلة:** `deleteLead` في الكود بيمنع الـ team_member، لكن الـ RLS بيسمحله. يعني أي حد بالـ JWT بتاعه يقدر يمسح leads العميل كلها. **الاختبار أكّدها.**
- **الإصلاح:** الـ migration §2 قسمت الـ policy لتلاتة: INSERT و UPDATE لأي حد عنده access (والـ UPDATE عليه WITH CHECK بيمنع نقل الـ lead لعميل تاني)، و DELETE للـ managers بس.

#### M2. حدود مقاعد الفريق مش متطبّقة في قاعدة البيانات
- **المكان:** `supabase/migrations/20261001100000_team_invites.sql:197` (`accept_invite`)، و:108 (policy الدعوات)
- **المشكلة:** `createInvite` بيحسب المقاعد والدعوات المعلّقة صح. لكن الأدمن يقدر يعمل insert في `organization_invites` مباشرة من الـ API، وكمان ممكن طلبين يحصلوا في نفس اللحظة. في الحالتين الدعوات بتتقبل ويتعدّى الحد، لأن `accept_invite` مكانتش بتفحص أي حد.
- **الإصلاح:** الـ migration §3: `accept_invite` بقت بترجع `limit_reached` لو مقاعد الوكالة أو العميل ممتلئة. الاشتراك غير النشط مش بيقفل على حد عنده دعوة، لأن ده مش دور النقطة دي. واتضاف `limit_reached` لـ `AcceptInviteStatus` مع ترجمته.
- **الاختبار:** عند الحد رجعت `limit_reached`، وبعد رفع الحد رجعت `ok` والعضو اتضاف صح.

#### M3. رسائل حدود المقاعد بتظهر كمفتاح خام
- **المكان:** `app/[locale]/dashboard/team/_components/invite-dialog.tsx:105` و`invites-list.tsx:23`
- **المشكلة:** الـ action بترجع `limitReached` / `clientLimitReached` / `subscriptionInactive`. الرسائل دي متكتبة في `team.errors`، لكن الـ dialog بيدوّر عليها في `invites.errors`. فالمستخدم كان هيشوف `invites.errors.limitReached` بالظبط في اللحظة اللي المفروض نقوله فيها يرقّي خطته.
- **الإصلاح:** المفاتيح اتضافت في `invites.errors` في `ar.json` و`en.json`.

#### M4. صفحات إعدادات العميل محمية من الـ layout بس
- **المكان:** `app/[locale]/dashboard/clients/[clientId]/layout.tsx:13`
- **المشكلة:** توثيق Next.js بيقول صراحة إن الـ layout مش بيتعمله render تاني مع الـ navigation (partial rendering)، فمينفعش يبقى هو الحماية الوحيدة.
- **الإصلاح:** اتضاف `requireClientManager(locale)` جوه كل صفحة من الخمسة: channels و knowledge و bot-settings و playground و subscription.

#### M5. مفيش error boundary ولا صفحة 404 مترجمة
- **المشكلة:** مكانش فيه `error.tsx` في أي حتة، وفيه 36 `throw new Error` في الـ loaders. أي مشكلة في Supabase كانت هتطلّع صفحة Next الافتراضية "Application error" بالإنجليزي، من غير أي طريقة للرجوع. وكمان صفحة 404 كانت الافتراضية بالإنجليزي.
- **الإصلاح:**
  - `src/components/route-error.tsx`: رسالة مترجمة، زرار "حاول مرة أخرى" (بيستخدم `retry()` الـ stable في Next 16.3)، رابط للوحة التحكم، ورمز الخطأ (digest) عشان الدعم يقدر يطابقه مع الـ logs.
  - `error.tsx` في `dashboard/` و`admin/` (القائمة الجانبية بتفضل ظاهرة) وفي `[locale]/`.
  - `app/global-error.tsx`: للأخطاء في الـ layout نفسه، والرسالة فيه باللغتين.
  - `app/[locale]/not-found.tsx` + `app/[locale]/[...rest]/page.tsx`، عشان أي رابط غلط يطلّع 404 مترجمة. **اتجربت:** `/ar/…` بترجع "الصفحة غير موجودة" و`/en/…` بترجع "Page not found"، والاتنين بـ HTTP 404.
  - `loading.tsx` (skeleton) في `dashboard/` و`admin/`.

#### M6. فشل فحص الحدود بيوقّع الصفحة
- **المكان:** `src/lib/subscription-limits.ts:8` (`rpcLimit` بيرمي exception)، واللي بينادوه: `clients.ts:135` و`channels.ts:79` و`team.ts:128` و`app/api/knowledge/upload/[clientId]/route.ts:40`
- **المشكلة:** لو الـ RPC فشل، الـ server action بترمي exception جوه `startTransition`، والصفحة كلها بتقع. وفي route رفع الملفات، الـ response كان بيبقى HTML 500 مش JSON.
- **الإصلاح:** اتعمل helper اسمه `guardLimit()` بيرجّع `'unknown'` ويسجّل الخطأ في الـ log. الـ actions بقت بترفض بأمان من غير ما ترمي، ولسه بتمنع العملية (fail closed). وفي `createInvite` اتعمل try/catch محلي. وفي route الرفع بقى بيرجع `uploadFailed` بـ 500 JSON.

#### M7. indexes ناقصة على foreign keys في جداول كبيرة
- **المشكلة:** لما محادثة تتمسح، رسايلها بتتمسح معاها (cascade)، ومع كل رسالة Postgres بيعمل `set null` على `leads.source_message_id`. من غير index ده بيبقى full scan لجدول `leads` مع كل رسالة. نفس المشكلة لما مستخدم يتمسح وقاعدة البيانات تدور على `messages.sender_id`.
- **الإصلاح:** الـ migration §4 أضافت indexes على:
  - `leads(source_message_id)`، `leads(assigned_to)`، `messages(sender_id)`، `lead_events(actor_id)`: partial indexes، مفلترة على `is not null`.
  - `conversations(channel_id)`، و`conversations(client_id, last_message_at desc)` عشان صفحة المحادثات.
  - `channels(client_id)`، `users(organization_id)`، `client_members(user_id)`، `organization_invites(organization_id)`.

---

## نتائج الفحص حسب القسم

### 1. قاعدة البيانات

| البند | النتيجة |
|---|---|
| الـ migrations بالترتيب | ✅ الـ 19 كلهم عدّوا، والـ 20 بعد الإصلاح |
| RLS على كل جدول | ✅ الـ 20 جدول كلهم. `invoice_counters` مقفول تماماً (مفيش عليه policy) وده مقصود، لأن الـ trigger بس هو اللي بيكتب فيه |
| جداول مكشوفة | ✅ مفيش. الـ views (`client_journey_stats` و`platform_stats`) الاتنين `security_invoker` |
| ON DELETE على الـ FKs | ✅ كلها CASCADE أو SET NULL. الاستثناء `plan_id` في `subscriptions` و`client_subscriptions`، ودول NO ACTION بقصد عشان يمنعوا مسح باقة مستخدمة |
| `search_path` في SECURITY DEFINER | ✅ الـ 59 function كلهم محدد لهم |
| رفع الصلاحيات (role / org) | ✅ الـ trigger `users_guard_privileges` بيمنعه. اتجرب: الـ team_member ميقدرش يغيّر دوره، والـ org_admin ميقدرش يرقّي حد لـ super_admin ولا ينقل عضو لمؤسسة تانية |

### 2. الصلاحيات (اختبار فعلي لكل دور)

عدد الصفوف اللي كل دور شافها. الـ seed فيه مؤسستين A و B، والمؤسسة A فيها عميلين، ومحادثتين واحدة منهم مسندة للـ team_member:

| الدور | clients | channels | conversations | messages | leads | knowledge | bot_settings | billing |
|---|---|---|---|---|---|---|---|---|
| super_admin | 3 | 3 | 2 | 2 | 3 | 1 | 3 | الكل |
| org_admin (A) | 2 | 2 | 2 | 2 | 2 | 1 | 2 | مؤسسته بس |
| org_admin (B) | 1 | 1 | 0 | 0 | 1 | 0 | 1 | مؤسسته بس |
| client_admin | 1 | 1 | 2 | 2 | 1 | 1 | 1 | عميله (قراءة بس) |
| team_member | 1 | 1 (من غير credentials) | **1 (المسندة ليه بس)** | 1 | 1 | **0** | **0** | **0** |

- **الـ RPCs:** اتجربت كلها بين المؤسسات والأدوار، ورجعت `forbidden` أو `not_found` أو `null` زي المفروض. ومنها: `change_client_plan`، `mark_invoice_paid`، `remove_org_member`، `get_*_details`، `get_all_*`، `check_*_limit`.
- **الـ server actions:** الـ 17 ملف كلهم اتراجعوا. كل action فيها تحقق من الـ session والدور قبل أي عملية، وفي الآخر الـ RLS بيحمي.
- **الـ API routes:**
  - `playground` و`knowledge/upload`: تسجيل دخول + client manager.
  - `webhook`: عام بقصد، وبيتحقق من القناة ومن ملكية المحادثة.
  - `auth/callback`: بيمنع الـ open redirect.
  - `health`: مفيهوش بيانات.
- **الصفحات:** `admin/*` كلها فيها `requireSuperAdmin`، و`clients/[clientId]/*` بقت محمية جوه كل صفحة (M4)، و`billing` و`subscription` فيهم `isOrgAdmin`. الـ proxy بيحوّل أي حد مش مسجل دخول لصفحة الدخول (اتجرب: 307 لـ `/ar/login`).
- **الـ team_member:** ميقدرش يوصل لـ channels و knowledge و bot-settings و playground (بيتحوّل لصفحة المحادثات)، ولا لـ team و billing و subscription (بيتحوّل للوحة التحكم)، لا على مستوى الصفحة ولا الـ action ولا الـ RLS.

### 3. حدود الاشتراكات

| العملية | فحص في الكود | backstop في قاعدة البيانات |
|---|---|---|
| إضافة عميل | `checkOrgLimit('clients')` في `clients.ts` | trigger `clients_enforce_limit` |
| إضافة قناة | `checkClientLimit('channels')` في `channels.ts` | trigger `channels_enforce_limit` |
| رفع ملف معرفة | `checkClientLimit('knowledge_docs')` في route الرفع | trigger `knowledge_documents_enforce_limit` |
| دعوة عضو | `checkOrgLimit` + `checkClientLimit('team_members')` + الدعوات المعلّقة | **`accept_invite` (جديد، M2)** |
| رد الـ AI | `checkClientLimit('messages')` في الـ webhook | `consume_client_message` (service role بس) |

### 4. الأمان
- **`SUPABASE_SECRET_KEY`:** موجود في `src/lib/supabase/admin.ts` بس، والملف ده فيه `import 'server-only'`. بيستخدمه الـ webhook و route الرفع وحساب الدعوات المعلّقة في `team.ts`، والتلاتة server.
- **Secrets:** قيم كل الـ secrets في `.env.local` مش موجودة في `.next/static` ولا `.next/server` ولا في أي ملف في git. والـ `.dockerignore` بيستبعد `.env*`.
- **SQL injection:**
  - مفيش SQL بيتبني كنص.
  - البحث (`or()`/`ilike`) بيعدّي على `searchTerm()` اللي بيشيل الحروف الخاصة.
  - `execute format` موجود في الـ migrations بس، وعلى أسماء ثابتة.
- **XSS:**
  - مفيش `dangerouslySetInnerHTML` غير في `chart.tsx` بتاع shadcn، وده CSS جاي من config ثابت.
  - الـ widget بيستخدم `textContent` للرسايل، و`innerHTML` للأيقونات الثابتة بس.
  - الروابط اللي بتتبني من بيانات (`tel:` و`wa.me`) ليها prefix ثابت.
  - الـ CSV بيتحمى من formula injection.
- **Open redirect:** `?next=` في صفحة الدخول و`/auth/callback` بيقبلوا مسارات داخلية بس.
- **Rate limit على الـ webhook:** شغال: 20 رسالة في الدقيقة لكل IP لكل قناة. لكن ليه قيود مكتوبة في التحسينات (I1).

### 5. الأخطاء
- اتضافت error boundaries و not-found و loading (M5)، وفشل فحص الحدود بقى مش بيوقّع الصفحة (M6).
- رسايل الأخطاء كلها بتعدّي على مفاتيح ترجمة. اتعمل script بيقارن الأخطاء اللي كل action ممكن ترجعها بالمفاتيح اللي في الـ namespace بتاع الـ component، وطلعت منه M3 بس.

### 6. الترجمات
- `ar.json` و`en.json` فيهم نفس المفاتيح بالظبط (1206 في كل واحد قبل الإصلاح، و1217 بعده).
- مفيش نصوص إنجليزي hardcoded في الواجهة، غير اسم البراند "Advertema AI" وقيم placeholder تقنية (slug).

### 7. الأداء
- الـ indexes: اتصلّحت (M7).
- الـ `select('*')` و N+1: موجودة في التحسينات (I6 و I7). مفيش N+1 حقيقي؛ كل القوايم بتجيب البيانات المرتبطة بـ embed في نفس الاستعلام.

---

## تحسينات

| # | المكان | الملاحظة | الإصلاح المقترح |
|---|---|---|---|
| I1 | `app/api/webhook/website/[channelId]/route.ts:21-36, 183` | الـ rate limiter في الذاكرة ولكل instance بس. بيعتمد إن Traefik يشيل `X-Forwarded-For` اللي جاي من العميل (ده الـ default). لو الـ map وصلت لـ 10 آلاف مفتاح بيتعمل `clear()` فالعدادات كلها بتتصفّر. والـ GET (استرجاع رسايل الـ agent) مفيهوش rate limit | الأفضل Redis أو جدول في Supabase. أو على الأقل تمسح المفاتيح المنتهية بس بدل `clear()`، وتحط limit أخف على الـ GET |
| I2 | نفس الملف :294 و :313 | كشف الـ leads (مكالمة Gemini) كان بيشتغل حتى لو اشتراك العميل أو الوكالة مش نشط، يعني فيه تكلفة AI على عملاء مش بيدفعوا | **اتصلّح:** `detectLead` في `src/lib/ai/lead-detection.ts` بقت بتنادي `clientSubscriptionActive()` قبل أي مكالمة لـ Gemini، فكل مسار بيشغّل تحليل الـ leads (الرد العادي، الـ fallback، الـ handoff) بقى متغطّي. الفحص fail closed: لو مفيش اشتراك أو الفحص نفسه فشل، مفيش مكالمة AI. العميل اللي اشتراكه نشط بس عدّى حد الرسايل لسه بيتحلّل، لأن المطلوب كان الاشتراكات غير النشطة بس |
| I3 | `src/lib/actions/playground.ts` | الـ playground مكانش بيتحسب من حد الرسايل، وكان بيشتغل حتى لو الاشتراك مش نشط | **اتصلّح:** `testBot` بقت بتعمل نفس فحص الويدجت (`check_client_limit('messages')`) قبل أي مكالمة AI، وبترجع `limitReached` أو `subscriptionInactive` برسالة مترجمة، أو `unknown` لو الفحص نفسه فشل (fail closed). وبعد كل رد ناجح بتنادي `consume_client_message`، فكل رد بيتحسب من نفس رصيد الويدجت، ومعاينة الإعدادات اللي لسه ما اتحفظتش بتتحسب برضه. الفرق الوحيد عن الويدجت إن الأدمن بيشوف رسالة خطأ واضحة بدل رسالة الـ fallback |
| I4 | `supabase/migrations/20261001100000_team_invites.sql:59` | الـ client_admin (وأي أدمن) كان يقدر يضيف أو ينقل عضو لعميل من الـ API مباشرة ويعدّي حد مقاعد العميل | **اتصلّح:** `supabase/migrations/20261009100000_client_seat_limit.sql` فيها trigger على `client_members` (insert أو update لـ client_id) بيرفض أي مقعد جديد لو الحد اتوصل له. نفس قاعدة `accept_invite`: الاشتراك غير النشط مش بيرفض، والعضو الموجود أصلاً مش بيتحسب مقعد جديد، فتغيير الدور شغال. واتضاف trigger بيعيد حساب العدادات للعميلين لما عضو يتنقل من عميل لعميل، لأن ده مكانش بيحصل. و`acceptInvite` بقت بترجع `limit_reached` لو قبولين حصلوا في نفس اللحظة على آخر مقعد |
| I5 | `supabase/migrations/20260924090333_rls_policies.sql:147` | الـ team_member يقدر يعمل insert لمحادثات من الـ API. مفيش ضرر حقيقي منه | قصر الـ INSERT على الـ managers |
| I6 | `app/[locale]/dashboard/layout.tsx:38`، `clients.ts:97,112`، `subscription.ts:47`، `client-subscription.ts:72`، `agency-billing.ts:118`، `admin-subscriptions.ts:129,283`، `admin-plans.ts:53` | `select('*')`. الجداول صغيرة، لكن الـ layout بيجيب صف المستخدم كامل مع إنه محتاج `full_name` و`role` بس | تحديد الأعمدة |
| I7 | `src/lib/actions/admin-plans.ts:127` | `reorderPlans` بيعمل update لكل باقة لوحدها بالتوازي (أقصى حاجة 100). الشاشة دي للـ super admin بس | RPC واحدة |
| I8 | `src/lib/auth/session.ts:11` | `getSession()` مكانتش جوه `cache()`، فكل action أو loader في نفس الـ request كان بيعمل `auth.getUser()` (مكالمة لـ Supabase Auth) واستعلام للمستخدم. الصفحة الواحدة كانت بتوصل لـ 3 أو 4 مرات | **اتصلّح:** `getSession` بقت ملفوفة في React `cache()`، فكل الاستدعاءات في نفس الـ request بقت مكالمة واحدة. الـ cache ده scope بتاعه الـ request بس، وCache Components مش شغالة في المشروع |
| I9 | `src/lib/actions/team.ts:38` | رابط الدعوة دايماً `/ar/invite/…` | استخدام لغة اللي بيبعت الدعوة |
| I10 | `messages/ar.json:990` | `admin.badge` مكتوبة "Super Admin" بالإنجليزي في النسخة العربي | "مدير المنصة" |
| I11 | `messages/*.json:778` | المفتاح `invites.accept.errors.ok` فاضي ومش مستخدم | مسحه |
| I12 | `src/lib/supabase/middleware.ts` | `updateSession` مش مستخدمة في أي حتة، والـ proxy هو اللي بيعمل الشغل ده | مسح الملف |
| I13 | Foreign keys على جداول صغيرة: `custom_pricing` و`client_custom_pricing` و`invoices.subscription_id` و`subscriptions.plan_id` | من غير indexes. تأثيرها ضعيف دلوقتي | تتضاف لو الجداول كبرت |
| I14 | الدوال المساعدة (`has_client_access` و`user_role` و`user_org` و`is_client_manager`) | `anon` يقدر ينفّذها بسبب الـ default grants في Supabase. مفيش تسريب، لأن `auth.uid()` بيبقى null | `revoke … from anon` للنضافة |
| I15 | `src/lib/actions/appointments.ts:84` | `setAppointment` كانت بتستعلم قبل ما تتحقق من الـ UUID والـ session. **اتصلّحت** لأنها سطرين | — |

---

## الملفات اللي اتغيّرت

**جديدة:**
- `supabase/migrations/20261008100000_launch_audit_fixes.sql`
- `src/components/route-error.tsx`
- `app/global-error.tsx`
- `app/[locale]/error.tsx`، `app/[locale]/not-found.tsx`، `app/[locale]/[...rest]/page.tsx`
- `app/[locale]/dashboard/error.tsx`، `app/[locale]/dashboard/loading.tsx`
- `app/[locale]/admin/error.tsx`، `app/[locale]/admin/loading.tsx`

**متعدّلة:**
- `src/lib/subscription-limits.ts`، `src/lib/actions/channels.ts`، `src/lib/actions/clients.ts`، `src/lib/actions/team.ts`، `src/lib/actions/appointments.ts`
- `src/lib/ai/lead-detection.ts` (I2)، `src/lib/auth/session.ts` (I8)
- `src/lib/actions/playground.ts`، `src/lib/types/playground.ts`، `app/api/playground/[clientId]/route.ts` (I3)
- `supabase/migrations/20261009100000_client_seat_limit.sql` جديدة (I4)
- `app/[locale]/admin/_components/subscription-actions.tsx`: شيلت imports ومتغير مش مستخدمين عشان eslint يبقى نضيف
- `src/lib/types/team.ts`
- `app/api/knowledge/upload/[clientId]/route.ts`
- `app/[locale]/dashboard/clients/[clientId]/{channels,knowledge,bot-settings,playground,subscription}/page.tsx`
- `messages/ar.json`، `messages/en.json`

**ترتيب النشر:** انشر الكود الأول، أو الاتنين مع بعض، وبعدين طبّق الـ migration (`supabase db push`). الكود الجديد بيشتغل عادي على قاعدة البيانات القديمة. لكن لو الـ migration اتطبقت مع الكود القديم، `accept_invite` ممكن ترجع `limit_reached` والواجهة القديمة معندهاش ترجمة ليها.
