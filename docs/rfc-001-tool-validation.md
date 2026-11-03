RFC-001: Tool Call Validation & Self-Correction Loop

· Status: Draft / Ready for Implementation
· Author: xlfzxr
· Scope: packages/core, apps/api, packages/transport
· Goal: Mengubah kegagalan parsing/mapping tool call DSML menjadi feedback loop yang memungkinkan model (DeepSeek) untuk memperbaiki dirinya sendiri (ReAct pattern), tanpa memutus koneksi streaming.

1. Ringkasan Eksekutif

Saat ini, jika model menghasilkan DSML yang tidak valid atau melanggar JSON Schema tool opencode, sistem cenderung gagal atau membuang output. RFC ini mendefinisikan standar Error Contract dan Validation Layer internal. Jika tool call tidak valid, sistem akan mengirimkan synthetic tool result (berisi pesan error) kembali ke model, sehingga model bisa mencoba lagi di iterasi berikutnya.

2. Kontrak Error (Baru & Stabil)

Semua kegagalan validasi HARUS mengembalikan satu objek tunggal:

```json
{
  "ok": false,
  "error": {
    "code": "tool_arguments_invalid" | "tool_not_found" | "tool_arguments_unparsable",
    "message": "String (maks 200 char, tanpa data sensitif)",
    "path": "JSON Pointer (RFC 6901), e.g., /model",
    "tool": "Nama tool yang dipanggil",
    "detail": {} // Opsional, daftar max 5 violations
  }
}
```

Aturan: code bersifat enum tertutup. message tidak boleh memuat stack trace atau nilai rahasia.

3. Mesin Validasi (Internal Subset)

· Lokasi: packages/core/src/orchestration/tool-parser.mjs (fungsi validateToolCall).
· Pendekatan: Validator JSON Schema subset (tanpa dependency ajv).
· Keyword yang Didukung: type, required, properties, additionalProperties: false, items, enum, minimum/maximum, minLength/maxLength.
· Keyword yang Diabaikan: oneOf, anyOf, $ref, format (dianggap lolos).
· Normalisasi: Input string di-parse via JSON.parse. Jika gagal, lempar tool_arguments_unparsable. Jika sukses, validasi tipe.
· Error Collection: Kumpulkan semua pelanggaran (maksimal 5) ke dalam array detail.violations agar model tahu semua kesalahannya sekaligus.

4. Integrasi ke ReAct Loop & Transport

4.1 Loop Integration (tool-loop.mjs)

```javascript
const verdict = validateToolCall(payload, tools);
if (!verdict.ok) {
    yield { type: "tool_call_invalid", payload: { ...payload, validation: verdict.error } };
    continue; // Jangan hentikan loop, biarkan model merekoveri
}
yield { type: "tool_call_done", payload };
```

4.2 Handler (Streaming & Non-Streaming)

· Streaming: Tulis frame tool-call dengan arguments berisi JSON.stringify(validationError), status "error". Jangan tutup koneksi (res.end()).
· Non-Streaming: Masukkan ke array tool_calls dengan format yang sama. Set finish_reason menjadi "tool_calls".

4.3 Serialisasi Transport

· arguments wajib berupa string JSON (JSON.stringify(validationError)), bukan objek mentah. Ini agar backward-compatible dengan OpenAI Schema.

---

🚨 5. Tambahan: Perbaikan Mendesak (Immediate Fixes)

Bagian ini tidak ada di screenshot, tapi WAJIB diimplementasikan sebelum rilis agar loop tidak berjalan liar.

5.1 Edge Case: Missing id pada Tool Call

Jika DSML gagal di-parse total, kita mungkin tidak punya tool_call_id. OpenAI spec mewajibkan id ada.

· Fix: Generate ID fallback unik (e.g., call_err_${Date.now()}_${random}) saat membuat synthetic error tool call. Model butuh id ini untuk merujuk error tersebut di pesan berikutnya.

5.2 Batas Maksimal Reaksi (Anti-Looping)

Model bisa saja ngotot mengirim format yang salah berkali-kali hingga token habis.

· Fix: Tambahkan state tracking di tool-loop.mjs. Jika terjadi tool_call_invalid sebanyak > 3 kali untuk tool yang sama dalam satu turn, paksa break loop dan fallback ke respons teks: "Sistem gagal mengeksekusi tool karena format tidak valid berulang kali."

5.3 DSML di Dalam String Arguments

Model sering salah menaruh closing tag DSML atau pipe ｜ di dalam nilai string argumen (misal: {"code": "print('|')"}).

· Fix: Parser DSML harus memastikan closing delimiter hanya ditangkap jika berada di luar quotes string JSON. Jangan sekadar pakai split().

5.4 Guardrail Token (Truncation Error)

Jika respons model terpotong di tengah jalan (kena limit max_tokens) sehingga DSML tidak tertutup.

· Fix: Tangkap event finish_reason: "length". Jika terdeteksi DSML tidak tertutup, langsung lempar error tool_arguments_unparsable dengan pesan: "Output terpotong. Harap ringkas argumen Anda."

---

6. Rencana Verifikasi (Sesuai AGENTS.md)

Uji manual (tanpa menambah test suite permanen) dengan urutan:

1. node --check pada setiap file yang diubah.
2. Kasus valid: Model mengembalikan DSML valid → respons tool_call normal.
3. Kasus required hilang: {} → tool_arguments_invalid (path: /text).
4. Tipe salah: {"text": 42} → tool_arguments_invalid (path: /text, expected: string).
5. Tool tidak dikenal: nama: nope → tool_not_found.
6. Argumen bukan JSON: string "not json" → tool_arguments_unparsable.
7. AdditionalProperties: Field ekstra → error path menunjuk field ekstra.
8. Non-stream: Bentuk tool_calls[].function.arguments adalah string JSON error.
9. Tanpa tools: Perilaku identik (regresi no-op).

7. Urutan Eksekusi

1. Baca tool-parser.mjs, tool-call-registry.mjs, dsml.mjs.
2. Implementasi validateToolCall + validator subset.
3. Sambungkan ke tool-loop.mjs (tambahkan logika max retry dari bagian 5.2).
4. Tangani event baru di chat-completions & responses handler.
5. node --check & jalankan verifikasi manual.
6. Update CHANGELOG.md.

---

Catatan Tambahan: Spesifikasi ini berfokus pada ketahanan (resilience). Pastikan logging mencatat setiap tool_call_invalid (beserta raw DSML-nya) ke file log, agar kita bisa menganalisis pola kesalahan model dan memperbaiki prompt di iterasi berikutnya.
