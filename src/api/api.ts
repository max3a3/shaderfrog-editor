import { createContext, useContext } from 'react';
import { ClientApi } from './ClientApi';

export const API = {
  assets: 'assets',
  shader: 'shader',
};

// todo need to implement this context data 
export const ClientApiContext = createContext<ClientApi | null>(null);
export const useApi = () => {
  return useContext(ClientApiContext)!;
};
