/// <reference types="vite/client" />

declare module 'axios' {
  export interface AxiosError<T = any> extends Error {
    response?: {
      data?: T;
      status?: number;
      statusText?: string;
    };
  }
  
  export function isAxiosError(error: any): error is AxiosError;
  
  export default function axios(config: any): Promise<any>;
  export function post<T = any>(url: string, data?: any, config?: any): Promise<{ data: T }>;
  export function get<T = any>(url: string, config?: any): Promise<{ data: T }>;
}

interface ImportMetaEnv {
  readonly VITE_ROBOFLOW_API_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
