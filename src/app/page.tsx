'use client';

import { useCallback, useRef, useState } from 'react';

// Allowed MIME types for PDF and DOCX. Some browsers may not populate `file.type` so we also do a filename extension fallback in `validate`.
type ValidMime =
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const max_bytes = 10 * 1024 * 1024; // 10 MB hard limit
const acceptedMimes: ValidMime[] = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

export default function HomePage() {
  const [file, setFile] = useState<File | null>(null); // Selected file 
  const [error, setError] = useState<string>(''); // Inline validation message
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null); // Hidden <input type="file" /> ref 

  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<string>('');

  // Validate a file by type (MIME/extension) and size.
  const validate = (f: File | null) => {
    if (!f) return 'Please select a file.';
    if (!acceptedMimes.includes(f.type as ValidMime)) {
      // Fallback: some browsers (or certain OS integrations) may not set `type`.
      const name = f.name.toLowerCase();
      const isPdf = name.endsWith('.pdf');
      const isDocx = name.endsWith('.docx');
      if (!isPdf && !isDocx) return 'Only PDF (.pdf) or DOCX (.docx) are allowed.';
    }

    if (f.size > max_bytes) return 'File is larger than 10 MB.'; // Enforce 10 MB cap

    return '';  // Valid
  };

  // Handler after user picks/drops a file.
  const handlePicked = (f: File | null) => {
    const msg = validate(f);
    setError(msg);
    setFile(msg ? null : f);
    setResult(''); // Clear any previous result when user changes file
  };

  // Runs when user chooses a file via the hidden input.
  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    handlePicked(f);
  };

  // Handle file dropped 
  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault(); // Prevent defaults to avoid the browser opening the file in a new tab
    e.stopPropagation();
    setIsDragging(false);
    const f = e.dataTransfer.files?.[0] ?? null; // Forward the first file to validator
    handlePicked(f);
  }, []);

  // While dragging over, keep the dropzone in "active" style.
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  };

  // Reset active style if the cursor leaves the dropzone.
  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  // Programmatically open the file picker when user clicks the dropzone.
  const openPicker = () => inputRef.current?.click();

  // Button enables only if there is a valid file (non-null and no error)
  const isValid = !!file && !error;

  // Summarize handler
  const onSummarize = async () => {
    console.log("called onSummarize fn")
    if (!file) return;
    setIsLoading(true);
    setError('');
    setResult('');

    try {
      const form = new FormData();
      form.append('file', file);

      const res = await fetch('/api/summarize', {
        method: 'POST',
        body: form,
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data?.error || 'Failed to summarize.');
        setResult('');
        return;
      }

      setResult(data.markdown as string);
    } catch (e) {
      setError('Network error. Please try again.');
      setResult('');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">AI Report Summarizer</h1>
        <p className="mt-2 text-sm text-gray-600">
          Upload a <span className="font-medium">PDF</span> or <span className="font-medium">DOCX</span> (≤ 10 MB).
        </p>

        <div
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          className={[
            'mt-6 flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-10 transition',
            isDragging ? 'border-indigo-500 bg-indigo-50' : 'border-gray-300 bg-white hover:bg-gray-50',
          ].join(' ')}
          onClick={openPicker}
          role="button"
          aria-label="Upload file"
        >
          {/* Hidden native file input (accept filters at OS dialog level) */}
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            onChange={onInputChange}
          />

          <div className="text-center">
            <div className="mx-auto mb-3 h-10 w-10 rounded-full border border-gray-300" />
            <p className="text-sm text-gray-700">
              Drag & drop your file here, or <span className="text-indigo-600 underline">choose a file</span>
            </p>
            <p className="mt-1 text-xs text-gray-500">Accepted: .pdf, .docx • Max 10 MB</p>
          </div>
        </div>

        {/* ---- Validation / Selection ---- */}
        <div className="mt-4">
          {file ? (
            <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
              ✅ <span className="font-medium">Selected:</span> {file.name}{' '}
              <span className="text-green-700">
                ({(file.size / (1024 * 1024)).toFixed(2)} MB)
              </span>
            </div>
          ) : null}

          {/* Error panel if validation failed */}
          {error ? (
            <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              ⚠️ {error}
            </div>
          ) : null}
        </div>

        {/* Actions*/}
        <div className="mt-6 flex items-center gap-3">
          <button
            disabled={!isValid || isLoading}
            className={[
              'rounded-2xl px-5 py-2.5 text-sm font-medium transition',
              !isValid || isLoading
                ? 'cursor-not-allowed bg-gray-200 text-gray-500'
                : 'bg-indigo-600 text-white shadow hover:bg-indigo-700',
            ].join(' ')}
            onClick={onSummarize}// fn to fetch to /api/summarize 
          >
                {isLoading ? 'Summarizing…' : 'Summarize'}
          </button>

          <button
            className="rounded-2xl border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            onClick={() => {
              // Reset everything
              setFile(null);
              setError('');
              setResult('');
              if (inputRef.current) inputRef.current.value = '';
            }}
            type="button"
          >
            Clear
          </button>
        </div>
        {result ? (
        <div className="mt-6">
            <h2 className="text-lg font-semibold">Summary</h2>
            <pre className="mt-2 whitespace-pre-wrap rounded-xl border border-gray-200 bg-white p-4 text-sm">
                {result}
            </pre>
          </div>
        ) : null}
      </div>
    </main>
  );
}
