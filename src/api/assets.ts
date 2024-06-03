import useSWR from 'swr';
import { API } from './api';
import { AssetsAndGroups } from '@editor/model/Asset';
const  NO_DATA = {groups:{},assets:{}}

export const useAssetsAndGroups = () => {
  // const { data } = useSWR(API.assets);
  return NO_DATA;
};
