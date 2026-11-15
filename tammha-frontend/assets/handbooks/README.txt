Official graduation-project handbook PDFs of the four universities go here
(Almaarefa University, Jouf University, Princess Nourah bint Abdulrahman University, University of Tabuk).

No PDF is included: the official files have not been provided yet, so the handbook page shows
"الدليل غير متاح حاليًا" / "Handbook not available" for all four.

When a file is provided: copy it here and fill its entry in handbooks-data.js (see the comment there).
On the server the same PDF is added with:
  npm run handbook -- setup-universities
  npm run handbook -- upload --university almaarefa --file <path-to-pdf> --title "<official title>"
