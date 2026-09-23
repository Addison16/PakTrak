import { useRef, useState } from "react";
import { ApiError } from "./api";

export default function useBackgroundError() {
  const [error, setError] = useState<Error | null>(null);
  const fingerprint = useRef("");
  return {
    error,
    failed(problem: Error) {
      const key = problem instanceof ApiError ? `${problem.action}:${problem.code}:${problem.status}` : problem.message;
      // A dismissed outage stays dismissed until recovery or a different failure.
      if (key !== fingerprint.current) { fingerprint.current = key; setError(problem); }
    },
    recovered() { fingerprint.current = ""; setError(null); },
    dismiss() { setError(null); },
  };
}
