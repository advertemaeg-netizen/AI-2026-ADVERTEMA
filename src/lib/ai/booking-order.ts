/**
 * The booking order, injected by code into every client's prompt after the
 * booking JSON instructions (buildSystemPrompt). Not client-editable: clients
 * configure information and tone, not the booking flow.
 *
 * Modern Standard Arabic on purpose: these are instructions to the model, not
 * output; the replies stay in the visitor's dialect. The last line stays for
 * good: a client prompt that brings its own order (the demo's rule 1 asks for
 * the name first) must not matter.
 *
 * Copied by script from the agreed text, never retyped: this terminal shows
 * Arabic reversed, so it is checked by character count, not by reading.
 * Agreed text 692 characters; shipped 609, with two lines held back and the
 * list renumbered (sha256 4a05129dcf4e):
 * - the branch line, until the bot reads each branch's hours (the branches
 *   step): emitted now, it would suppress "which branch?" while the database
 *   holds one branch and the clinic has two;
 * - the service line, until a per-client setting says whether the service
 *   changes the duration or the price.
 * Code holds the same order: the appointment is complete with a day and a
 * time, and the name and then the mobile number are asked for by code, one at
 * a time (appointmentLine, nextQuestion).
 */
export const BOOKING_ORDER_INSTRUCTIONS = `## ترتيب الحجز

اجمع تفاصيل الموعد أولًا، ثم بيانات التواصل. لا تخلط بينهما.

أولًا — تفاصيل الموعد، بهذا الترتيب:
1. اليوم.
2. الساعة.

ثانيًا — بعد أن يكتمل الموعد ويُقبل:
3. الاسم.
4. رقم الموبايل.

قواعد ثابتة:
- اسأل عن شيء واحد في الرسالة الواحدة.
- لا تطلب الاسم ولا الرقم قبل أن يكتمل الموعد.
- لا تسأل مرة أخرى عن شيء قاله العميل بالفعل.
- إذا رُفض وقت لأنه خارج المواعيد، فالفرع والخدمة واليوم تبقى كما هي — اسأل عن الوقت وحده.
- لا تفترض يومًا ولا ساعة لم يذكرها العميل.
- لا تؤكد الحجز ولا تقل إنه تم قبل أن يكتمل الموعد والاسم والرقم.

هذا الترتيب يعلو على أي ترتيب آخر ورد قبله في هذه التعليمات.`
