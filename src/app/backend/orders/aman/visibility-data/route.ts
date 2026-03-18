import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { sendPlainEmail } from '@/lib/gmail';

const BRANCH_EMAIL = process.env.BRANCH_EMAIL || '';

interface VisibilityMaterial {
  material_code: string;
  batch_number: string;
  order_quantity: number;
}

interface VisibilityPayload {
  email_body: string;
  materials: VisibilityMaterial[];
}

/**
 * POST /backend/orders/aman/visibility-data
 *
 * Receives ZSO-VISIBILITY response from Aman (auto_gui2) as multipart/form-data.
 * Expects a `file` field containing a `.json` file named `{soNumber}.json`.
 * The JSON file must contain `email_body` (string) and `materials` (array).
 *
 * 1. Extracts SO number from the uploaded filename (strips .json extension and leading spaces)
 * 2. Sends email_body to BRANCH_EMAIL
 * 3. Stores materials (with batch + quantity) on the Email record for later use in ZLOAD1
 * 4. Creates Email record with emailType='ls_dispatch' for tracking branch reply
 */
export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json(
        { error: 'No file received. Expected multipart/form-data with a "file" field.' },
        { status: 400 }
      );
    }

    const fileText = await file.text();
    console.log(`[VisibilityData] File "${file.name}" (${fileText.length} chars):`, fileText.slice(0, 500));

    let body: VisibilityPayload;
    try {
      body = JSON.parse(fileText);
    } catch {
      console.error(`[VisibilityData] JSON parse failed. File contents:`, fileText);
      return NextResponse.json(
        { error: 'Invalid JSON in uploaded file', receivedPreview: fileText.slice(0, 200) },
        { status: 400 }
      );
    }

    console.log(`[VisibilityData] Parsed payload keys:`, Object.keys(body));
    console.log(`[VisibilityData] materials=${body.materials?.length}, email_body length=${body.email_body?.length}`);
    console.log(`[VisibilityData] Full file contents:`, fileText);

    const { email_body, materials } = body;

    if (!email_body) {
      return NextResponse.json(
        { error: 'email_body is required' },
        { status: 400 }
      );
    }

    if (!materials || !Array.isArray(materials) || materials.length === 0) {
      return NextResponse.json(
        { error: 'materials array is required and must not be empty' },
        { status: 400 }
      );
    }

    // Extract SO number from filename: strip .json extension and leading spaces
    // auto_gui2's send_to_endpoint adds a space prefix to the filename (e.g., " 3260206.json")
    let soNumber = file.name.replace(/\.json$/i, '').trim();
    if (!soNumber) {
      const currentSO = await prisma.currentSO.findFirst();
      if (!currentSO) {
        return NextResponse.json(
          { error: 'Could not determine SO number from filename and no CurrentSO set' },
          { status: 404 }
        );
      }
      soNumber = currentSO.soNumber;
    }

    // Find the sales order
    const salesOrder = await prisma.salesOrder.findFirst({
      where: { soNumber },
      include: { items: true },
    });

    if (!salesOrder) {
      return NextResponse.json(
        { error: `Sales order not found: ${soNumber}` },
        { status: 404 }
      );
    }

    if (!BRANCH_EMAIL) {
      return NextResponse.json(
        { error: 'BRANCH_EMAIL environment variable not configured' },
        { status: 500 }
      );
    }

    // Create a LoadingSlipItem to attach the Email record to
    // (use first material as identifier, or create a placeholder)
    let loadingSlipItem = salesOrder.items[0];
    if (!loadingSlipItem) {
      loadingSlipItem = await prisma.loadingSlipItem.create({
        data: {
          salesOrderId: salesOrder.id,
          lsNumber: `DISPATCH-${soNumber}`,
          material: materials[0]?.material_code || 'PENDING',
          status: 'pending',
        },
      });
    }

    // Send dispatch status email to branch
    const subject = `Dispatch Status - Sales Order ${soNumber}`;
    const { messageId, threadId } = await sendPlainEmail(
      BRANCH_EMAIL,
      subject,
      email_body
    );

    console.log(
      `[VisibilityData] Sent dispatch email to ${BRANCH_EMAIL} for SO ${soNumber} - messageId: ${messageId}`
    );

    // Store full materials array (with batch + quantity) for ZLOAD1 later
    const materialsJson = JSON.stringify(materials);

    // Create Email record for tracking branch reply
    await prisma.email.create({
      data: {
        loadingSlipItemId: loadingSlipItem.id,
        gmailMessageId: messageId,
        gmailThreadId: threadId,
        recipientEmail: BRANCH_EMAIL,
        subject,
        status: 'sent',
        emailType: 'ls_dispatch',
        workflowState: 'awaiting_reply',
        relatedMaterials: materialsJson,
      },
    });

    console.log(
      `[VisibilityData] Created email record for SO ${soNumber} with ${materials.length} materials`
    );

    return NextResponse.json({
      success: true,
      so_number: soNumber,
      soNumber,
      emailSent: true,
      messageId,
      materialsCount: materials.length,
    });
  } catch (error) {
    console.error('[Aman API - Visibility Data] Error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
