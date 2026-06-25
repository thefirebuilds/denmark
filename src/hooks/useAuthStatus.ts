import { useCallback, useEffect, useState } from "react";
import { APP_EVENTS } from "../app/appEvents";
import { AUTH_EMAIL_STORAGE_KEY, buildLoginUrl } from "../lib/apiClient";

export type AuthInfo = {
  authEnforced: boolean;
  displayName: string | null;
  role: string | null;
} | null;

export type MarkAuthenticatedInput = {
  auth_enforced?: boolean;
  display_name?: string | null;
  role?: string | null;
  email?: string | null;
};

export function useAuthStatus(onAuthRequired: () => void) {
  const [authInfo, setAuthInfo] = useState<AuthInfo>(null);
  const [authRequired, setAuthRequired] = useState(false);

  const markAuthRequired = useCallback(() => {
    setAuthRequired(true);
    onAuthRequired();
  }, [onAuthRequired]);

  const markAuthenticated = useCallback((data: MarkAuthenticatedInput) => {
    setAuthRequired(false);
    setAuthInfo({
      authEnforced: data?.auth_enforced !== false,
      displayName: data?.display_name ?? null,
      role: data?.role ?? null,
    });

    if (data?.email && typeof window !== "undefined") {
      window.localStorage.setItem(AUTH_EMAIL_STORAGE_KEY, data.email);
    }
  }, []);

  useEffect(() => {
    window.addEventListener(APP_EVENTS.authRequired, markAuthRequired);

    return () => {
      window.removeEventListener(APP_EVENTS.authRequired, markAuthRequired);
    };
  }, [markAuthRequired]);

  return {
    authInfo,
    authRequired,
    buildLoginUrl,
    markAuthenticated,
    markAuthRequired,
    setAuthRequired,
  };
}
