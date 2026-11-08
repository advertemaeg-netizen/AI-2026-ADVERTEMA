# عيادة الياسمين — the content to paste into Mudrik

Everything below is invented. No real clinic, doctor, patient, phone number or
address appears anywhere in it. The phone number is deliberately unusable and
the street is called "Sample Street" in Arabic, so nobody can mistake this for
a live business.

The assets it belongs to, now live:

| | |
|---|---|
| Facebook Page | عيادة الياسمين لطب الأسنان — `1383954728139637` |
| Instagram | `@yasmine.dental.clinic` — `17841451030345148` |

---

## 1. The client

| Field | Value |
|---|---|
| Name | `عيادة الياسمين لطب الأسنان — حساب تجريبي` |
| Industry | `طب وتجميل الأسنان` |

**Description** — paste both lines:

```
عيادة أسنان في القاهرة بتقدّم الكشف والتنظيف والحشو والتقويم وزراعة الأسنان.
الحساب ده تجريبي، وكل البيانات اللي فيه متخيلة ومش لعيادة حقيقية.
```

The second line is not decoration. A reviewer who opens the knowledge base
should be told, inside the product, that none of it is real.

---

## 2. Bot settings

**System prompt**

```
انت مساعد عيادة الياسمين لطب الأسنان.
بتساعد الناس في معرفة الخدمات والأسعار والمواعيد، وبتحجزلهم كشف لو طلبوا.
اتكلم عربي مصري بسيط ومهذب، وردودك قصيرة.
لو السؤال عن حالة طبية أو تشخيص، قول إن ده بيتحدد في الكشف ومتديش رأي طبي.
لو مش عارف المعلومة، قول إنك هتسأل وترد، ومتخترعش حاجة.
```

**Welcome message**

```
أهلاً بيك في عيادة الياسمين 🌸 أقدر أساعدك في الأسعار أو المواعيد أو الحجز.
```

**Fallback message**

```
معنديش المعلومة دي دلوقتي. هسأل وأرد عليك، أو تقدر تكلّمنا في أي وقت.
```

**Tone:** `مهذب وبسيط`
**Language:** Arabic

---

## 3. The branch

| Field | Value |
|---|---|
| Name | `فرع المعادي` |
| Address | `١٢ شارع النموذج، المعادي، القاهرة` |
| Phone | `0100 000 0000` |
| Slot length | 30 minutes |
| Capacity per slot | 1 |

**Hours**

| Day | |
|---|---|
| السبت | 12:00 – 20:00 |
| الأحد | 12:00 – 20:00 |
| الاثنين | 12:00 – 20:00 |
| الثلاثاء | 12:00 – 20:00 |
| الأربعاء | 12:00 – 20:00 |
| الخميس | 12:00 – 20:00 |
| **الجمعة** | **closed** |

Friday is closed on purpose, and it is the single most valuable thing in this
whole setup. A reviewer who asks for a Friday appointment should watch the bot
decline a day rather than offer one. A product that says no correctly is more
convincing than one that says yes to everything.

---

## 4. Knowledge base — seven documents

Each heading is the document's title. Each block is its body.

### ١. الخدمات والأسعار

```
الكشف: ٣٠٠ جنيه، وبيتخصم من تكلفة العلاج لو اتعمل في نفس الزيارة.
تنظيف وتلميع: ٨٠٠ جنيه.
حشو عادي: من ٧٠٠ لـ ١٢٠٠ جنيه حسب حجم الحشو.
حشو عصب: من ٢٥٠٠ لـ ٤٠٠٠ جنيه حسب عدد القنوات.
تبييض بالليزر: ٤٥٠٠ جنيه للجلسة.
تقويم معدني: ٣٥٠٠٠ جنيه شامل المتابعة.
تقويم شفاف: من ٦٥٠٠٠ لـ ٩٠٠٠٠ جنيه حسب عدد الشرائح.
زراعة سنة: ١٨٠٠٠ جنيه شاملة التاج.
الأسعار دي تقديرية، والسعر النهائي بيتحدد بعد الكشف والأشعة.
```

### ٢. المواعيد والعنوان

```
العيادة في ١٢ شارع النموذج، المعادي، القاهرة.
تليفون العيادة: ٠١٠٠ ٠٠٠ ٠٠٠٠
بنشتغل من السبت للخميس، من ١٢ الظهر لـ ٨ بالليل. الجمعة مقفول.
الكشف بالحجز، والزيارة بتاخد حوالي نص ساعة.
```

### ٣. طرق الدفع

```
بنقبل كاش وفيزا وماستر كارد ومحفظة الموبايل.
التقويم والزراعة ليهم تقسيط على ٣ أو ٦ أو ١٢ شهر من غير فوايد.
التقسيط بيبدأ بمقدّم ٣٠٪، والباقي أقساط شهرية.
```

### ٤. الحجز والإلغاء

```
الحجز بيتم من هنا أو بالتليفون.
الإلغاء أو التأجيل من غير رسوم لو قبل الميعاد بـ ٤ ساعات على الأقل.
لو الحجز اتلغى بعد كده أو محضرتش، الكشف الجاي بيتحسب كامل.
بنستنى ١٥ دقيقة بعد الميعاد، وبعدها الدور بيروح للي بعده.
```

### ٥. الركنة والوصول

```
فيه جراج مجاني للعيادة في نفس المبنى.
العيادة في الدور الأول وفيها أسانسير.
أقرب محطة مترو: المعادي، وبعدها حوالي ١٠ دقايق مشي.
```

### ٦. أول زيارة: إيه اللي تجيبه معاك

```
هات بطاقتك، وأي أشعة أو تقارير قديمة لو عندك.
لو بتاخد أدوية بانتظام، اكتب أساميها أو هات العلبة معاك.
لو الزيارة لطفل، لازم يكون معاه حد بالغ.
احضر قبل الميعاد بـ ١٠ دقايق عشان الورق.
```

### ٧. الحالات المستعجلة

```
لو فيه ألم شديد أو ورم أو نزيف مستمر، كلّمنا على طول وهنحاول نلاقيلك ميعاد في نفس اليوم.
لو حصل كسر في سنة أو خلعت بعد حادث، احفظها في لبن أو محلول ملح وتعالى فوراً.
خارج مواعيد العيادة، روح أقرب مستشفى.
```

---

## 5. The three posts, for reference

These are already published on both accounts. They are here so the knowledge
base and the posts can be checked against each other — if a post names a price
the bot answers differently, a reviewer will see the contradiction.

- **Post 1** names: الكشف ٣٠٠ · تنظيف ٨٠٠ · تبييض ٤٥٠٠ · زراعة ١٨٠٠٠
- **Post 2** names: السبت–الخميس ١٢–٨ · الجمعة مقفول · ١٢ شارع النموذج · إلغاء قبل ٤ ساعات
- **Post 3** names: احضر قبل الميعاد بـ ١٠ دقايق · بنستنى ١٥ دقيقة

All three match documents 1, 2, 4 and 6 above. They were written from them.

---

## 6. One decision still open, before the recording

A reviewer may connect their own Instagram account to this clinic. With comment
replies switched on, Mudrik would then post public replies under the reviewer's
own posts.

That is acceptable and the instructions will say so plainly — but it means the
switch has to be on during review, on a client whose channel a stranger
controls.

**My call:** on for this client only, for the review period, off the day the
decision comes back. Not as a default, and not on any other client.
