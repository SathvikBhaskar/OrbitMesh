const API_BASE_URL = 'http://localhost:4000/api';

let accessToken: string | null = null;

export const setAccessToken = (token: string | null) => {
  accessToken = token;
};

const fetchWithAuth = async (url: string, options: RequestInit = {}) => {
  const headers = {
    ...options.headers,
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  } as Record<string, string>;

  const defaultOptions: RequestInit = {
    ...options,
    headers,
    credentials: 'include' // Important for sending/receiving HttpOnly cookies
  };

  let response = await fetch(url, defaultOptions);

  if (response.status === 401) {
    // Attempt to refresh
    const refreshResponse = await fetch(`${API_BASE_URL}/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (refreshResponse.ok) {
      const data = await refreshResponse.json();
      accessToken = data.accessToken;
      headers.Authorization = `Bearer ${accessToken}`;
      response = await fetch(url, { ...defaultOptions, headers });
    } else {
      // Refresh failed, clear token
      accessToken = null;
      // You could trigger a global logout event here
    }
  }

  return response;
};

function parseApiError(response: Response, data: any): Error {
  let message = `HTTP error! status: ${response.status}`;
  let code: string | undefined;

  if (data) {
    if (typeof data.error === 'string') {
      message = data.error;
    } else if (data.error && typeof data.error === 'object') {
      message = data.error.message || data.error.code || message;
      code = data.error.code;
    } else if (typeof data.message === 'string') {
      message = data.message;
    } else if (typeof data.reason === 'string') {
      message = data.reason;
    }
  }

  const err: any = new Error(message);
  err.status = response.status;
  err.code = code || (data && data.code);
  err.response = { status: response.status, data };
  return err;
}

export const api = {
  get: async (endpoint: string) => {
    const response = await fetchWithAuth(`${API_BASE_URL}${endpoint}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw parseApiError(response, data);
    }
    return response.json();
  },
  
  post: async (endpoint: string, data?: any) => {
    const response = await fetchWithAuth(`${API_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    if (!response.ok) {
      const respData = await response.json().catch(() => ({}));
      throw parseApiError(response, respData);
    }
    return response.json();
  },

  patch: async (endpoint: string, data?: any) => {
    const response = await fetchWithAuth(`${API_BASE_URL}${endpoint}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    if (!response.ok) {
      const respData = await response.json().catch(() => ({}));
      throw parseApiError(response, respData);
    }
    return response.json();
  }
};
