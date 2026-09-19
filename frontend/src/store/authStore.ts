import { create } from "zustand";
import { apiFetch } from "../api/client";
import { loginWithBiometric } from "../utils/webauthn";

type User = {
  id: string;
  username: string;
  email: string;
  role: "user" | "educator" | "admin";
  virtualBalance: string;
};

type PendingVerification = {
  pendingVerification: true;
  email: string;
  expiresInSeconds: number;
  message: string;
  devOtp?: string;
};

type AuthState = {
  token: string | null;
  user: User | null;
  loading: boolean;
  setToken: (token: string | null) => void;
  login: (input: { usernameOrEmail: string; password?: string; accessKey?: string }) => Promise<void>;
  loginBiometric: (usernameOrEmail: string) => Promise<void>;
  /** Step 1 of signup: submits the form and triggers an OTP email. Does not create the account yet. */
  register: (input: {
    username: string;
    email: string;
    password: string;
    confirmPassword: string;
    accessKey: string;
    confirmAccessKey: string;
    role?: "user" | "educator";
  }) => Promise<PendingVerification>;
  /** Step 2 of signup: confirms the emailed code, which is what actually creates the account and signs in. */
  verifyEmail: (input: { email: string; otp: string }) => Promise<void>;
  /** Requests a fresh OTP for an in-progress signup (rate-limited server-side). */
  resendOtp: (email: string) => Promise<PendingVerification>;
  logout: () => Promise<void>;
  updateBalance: (virtualBalance: string) => void;
};

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem("invexa-token"),
  user: null,
  loading: false,
  setToken: (token) => {
    if (token) {
      localStorage.setItem("invexa-token", token);
    } else {
      localStorage.removeItem("invexa-token");
    }
    set({ token });
  },
  login: async ({ usernameOrEmail, password, accessKey }) => {
    set({ loading: true });
    try {
      const data = await apiFetch<{ token: string; user: User }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ usernameOrEmail, password, accessKey })
      });
      get().setToken(data.token);
      set({ user: data.user });
    } finally {
      set({ loading: false });
    }
  },
  loginBiometric: async (usernameOrEmail) => {
    set({ loading: true });
    try {
      const data = await loginWithBiometric(usernameOrEmail);
      get().setToken(data.token);
      set({ user: data.user as User });
    } finally {
      set({ loading: false });
    }
  },
  register: async ({ username, email, password, confirmPassword, accessKey, confirmAccessKey, role }) => {
    set({ loading: true });
    try {
      return await apiFetch<PendingVerification>("/auth/register", {
        method: "POST",
        body: JSON.stringify({ username, email, password, confirmPassword, accessKey, confirmAccessKey, role })
      });
    } finally {
      set({ loading: false });
    }
  },
  verifyEmail: async ({ email, otp }) => {
    set({ loading: true });
    try {
      const data = await apiFetch<{ token: string; user: User }>("/auth/verify-email", {
        method: "POST",
        body: JSON.stringify({ email, otp })
      });
      get().setToken(data.token);
      set({ user: data.user });
    } finally {
      set({ loading: false });
    }
  },
  resendOtp: async (email) => {
    return apiFetch<PendingVerification>("/auth/resend-otp", {
      method: "POST",
      body: JSON.stringify({ email })
    });
  },
  logout: async () => {
    const token = get().token;
    if (token) {
      await apiFetch("/auth/logout", { method: "POST" }, token);
    }
    get().setToken(null);
    set({ user: null });
  },
  updateBalance: (virtualBalance) => {
    const current = get().user;
    if (current) {
      set({ user: { ...current, virtualBalance } });
    }
  }
}));
