import { prisma } from './prisma';
import { sendEmail } from './gmail';

interface VehicleDetails {
  vehicleNumber?: string | null;
  driverMobile?: string | null;
  containerNumber?: string | null;
  transportId?: string | null;
}

/**
 * Send Loading Slip file email to plant
 */
export async function sendLSEmail(
  loadingSlipItemId: string,
  soNumber: string,
  lsNumber: string,
  fileBuffer: Buffer,
  vehicleDetails: VehicleDetails,
  originalFilename?: string
): Promise<{ messageId: string; threadId: string }> {
  const plantEmail = process.env.PLANT_EMAIL;
  if (!plantEmail) {
    throw new Error('PLANT_EMAIL environment variable not configured');
  }

  const subject = `Loading Slip ${lsNumber} - SO ${soNumber}`;

  const bodyLines = [
    `Please find attached the Loading Slip ${lsNumber} for Sales Order ${soNumber}.`,
    '',
    'Vehicle Details:',
  ];

  if (vehicleDetails.vehicleNumber) {
    bodyLines.push(`- Vehicle Number: ${vehicleDetails.vehicleNumber}`);
  }
  if (vehicleDetails.driverMobile) {
    bodyLines.push(`- Driver Mobile: ${vehicleDetails.driverMobile}`);
  }
  if (vehicleDetails.containerNumber) {
    bodyLines.push(`- Container Number: ${vehicleDetails.containerNumber}`);
  }
  if (vehicleDetails.transportId) {
    bodyLines.push(`- Transport ID: ${vehicleDetails.transportId}`);
  }

  bodyLines.push('', 'Please reply with the invoice PDF.');

  const body = bodyLines.join('\n');

  // Determine filename and mime type
  const filename = originalFilename || `LS_${lsNumber}.pdf`;
  const isXls = /\.xls$/i.test(filename);
  const isXlsx = /\.xlsx$/i.test(filename);
  const mimeType = isXls
    ? 'application/vnd.ms-excel'
    : isXlsx
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'application/pdf';

  const { messageId, threadId } = await sendEmail(plantEmail, subject, body, {
    filename,
    content: fileBuffer,
    mimeType,
  });

  // Create Email record in database
  await prisma.email.create({
    data: {
      loadingSlipItemId,
      gmailMessageId: messageId,
      gmailThreadId: threadId,
      recipientEmail: plantEmail,
      subject,
      status: 'sent',
    },
  });

  return { messageId, threadId };
}

/**
 * Send LS emails for all items in a sales order
 */
export async function sendLSEmailsForOrder(
  salesOrderId: string,
  lsItems: Array<{
    loadingSlipItemId: string;
    lsNumber: string;
    pdfBuffer: Buffer;
  }>
): Promise<void> {
  const salesOrder = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: {
      soNumber: true,
      vehicleNumber: true,
      driverMobile: true,
      containerNumber: true,
      transportId: true,
    },
  });

  if (!salesOrder) {
    throw new Error(`Sales order not found: ${salesOrderId}`);
  }

  const vehicleDetails: VehicleDetails = {
    vehicleNumber: salesOrder.vehicleNumber,
    driverMobile: salesOrder.driverMobile,
    containerNumber: salesOrder.containerNumber,
    transportId: salesOrder.transportId,
  };

  for (const item of lsItems) {
    await sendLSEmail(
      item.loadingSlipItemId,
      salesOrder.soNumber,
      item.lsNumber,
      item.pdfBuffer,
      vehicleDetails
    );
  }
}
