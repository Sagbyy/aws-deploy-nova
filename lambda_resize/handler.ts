import { S3Event } from "aws-lambda";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import Jimp from "jimp";

const s3 = new S3Client({});

async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

export const handler = async (event: S3Event) => {

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    if (!key.startsWith("uploads/")) {
      continue;
    }

    const lowerKey = key.toLowerCase();
    const isJpeg = lowerKey.endsWith(".jpg") || lowerKey.endsWith(".jpeg");
    const isPng = lowerKey.endsWith(".png");

    if (!isJpeg && !isPng) {
      continue;
    }

    const input = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );

    if (!input.Body) {
      continue;
    }

    const original = await streamToBuffer(input.Body as any);
    const image = await Jimp.read(original);
    image.cover(400, 400);

    const outputMime = isPng ? Jimp.MIME_PNG : Jimp.MIME_JPEG;
    if (!isPng) {
      image.quality(85);
    }

    const resized = await image.getBufferAsync(outputMime);

    const fileName = key.split("/").pop() || "image";
    const outputExtension = isPng ? "png" : "jpg";
    const outputKey = `resized/${fileName.replace(/\.[^.]+$/, "")}.${outputExtension}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: outputKey,
        Body: resized,
        ContentType: isPng ? "image/png" : "image/jpeg",
        CacheControl: "public, max-age=31536000",
      }),
    );
  }

  return {
    statusCode: 200,
    body: "Image resized successfully",
  };
};
