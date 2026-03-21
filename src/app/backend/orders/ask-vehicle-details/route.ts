import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { sendReplyEmail, sendPlainEmail, getMessageRfc822Id } from '@/lib/gmail';

const BRANCH_EMAIL = process.env.BRANCH_EMAIL || '';

/**
 * POST /backend/orders/ask-vehicle-details
 *
 * Manually trigger the vehicle details email for a given SO.
 * Used when ZLOAD1 is already done but the vehicle details email
 * wasn't sent automatically (e.g., resuming mid-flow).
 */
export async function POST(request: Request) {
  try {
    const { soNumber } = await request.json();

    if (!soNumber) {
      return NextResponse.json({ error: 'soNumber is required' }, { status: 400 });
    }

    if (!BRANCH_EMAIL) {
      return NextResponse.json({ error: 'BRANCH_EMAIL not configured' }, { status: 500 });
    }

    const salesOrder = await prisma.salesOrder.findFirst({
      where: { soNumber },
      include: { items: true },
    });

    if (!salesOrder) {
      return NextResponse.json({ error: `Sales order not found: ${soNumber}` }, { status: 404 });
    }

    // Need a LoadingSlipItem to attach the Email record to
    const loadingSlipItem = salesOrder.items[0];
    if (!loadingSlipItem) {
      return NextResponse.json({ error: 'No LoadingSlipItem found for this SO' }, { status: 404 });
    }

    // Check for existing vehicle_details email to prevent duplicates
    const existingEmail = await prisma.email.findFirst({
      where: {
        loadingSlipItemId: loadingSlipItem.id,
        emailType: 'vehicle_details',
        status: 'sent',
      },
    });
    if (existingEmail) {
      return NextResponse.json({ error: 'Vehicle details email already sent for this SO' }, { status: 409 });
    }

    const vehicleEmailBody = [
      `Loading slip for Sales Order ${soNumber} has been created successfully.`,
      '',
      'Please reply with the following vehicle/transport details:',
      '1. Vehicle Number (e.g., GJ12AB1234)',
      '2. Driver Mobile Number (e.g., 9876543210)',
      '3. Container Number',
    ].join('\n');

    const subject = `Vehicle Details Required - SO ${soNumber}`;

    let emailResult: { messageId: string; threadId: string };

    if (salesOrder.originalThreadId && salesOrder.originalMessageId) {
      try {
        const rfc822Id = await getMessageRfc822Id(salesOrder.originalMessageId);
        if (rfc822Id) {
          emailResult = await sendReplyEmail(BRANCH_EMAIL, subject, vehicleEmailBody, salesOrder.originalThreadId, rfc822Id);
        } else {
          emailResult = await sendPlainEmail(BRANCH_EMAIL, subject, vehicleEmailBody);
        }
      } catch {
        emailResult = await sendPlainEmail(BRANCH_EMAIL, subject, vehicleEmailBody);
      }
    } else {
      emailResult = await sendPlainEmail(BRANCH_EMAIL, subject, vehicleEmailBody);
    }

    await prisma.email.create({
      data: {
        loadingSlipItemId: loadingSlipItem.id,
        gmailMessageId: emailResult.messageId,
        gmailThreadId: emailResult.threadId,
        recipientEmail: BRANCH_EMAIL,
        subject,
        status: 'sent',
        emailType: 'vehicle_details',
        workflowState: 'awaiting_reply',
      },
    });

    console.log(`[AskVehicleDetails] Sent vehicle details email for SO ${soNumber} - messageId: ${emailResult.messageId}`);

    return NextResponse.json({
      success: true,
      soNumber,
      messageId: emailResult.messageId,
    });
  } catch (error) {
    console.error('[AskVehicleDetails] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
