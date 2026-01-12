export const DELIVERY_STATUS_OPTIONS = [
  'Vehicle Details Received',
  'Email Sent to Plant',
  'Email with Invoice Received',
  'Invoice Generated',
  'Shipment Details Created',
] as const;

export const ACCOUNT_PAYABLE_STATUS_OPTIONS = [
  'Email Sent to Plant',
  'Email with Invoice Received',
  'Account Payable Details Sent',
  'NA',
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUS_OPTIONS)[number];
export type AccountPayableStatus = (typeof ACCOUNT_PAYABLE_STATUS_OPTIONS)[number];
