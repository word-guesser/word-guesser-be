import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Bắt đầu seed dữ liệu từ vựng tiếng Việt...');

  // Create categories
  const fruits = await prisma.wordCategory.upsert({
    where: { name: 'trái cây' },
    update: {},
    create: { name: 'trái cây', description: 'Các loại trái cây' },
  });

  const bodyParts = await prisma.wordCategory.upsert({
    where: { name: 'bộ phận cơ thể' },
    update: {},
    create: { name: 'bộ phận cơ thể', description: 'Các bộ phận cơ thể người' },
  });

  const animals = await prisma.wordCategory.upsert({
    where: { name: 'động vật' },
    update: {},
    create: { name: 'động vật', description: 'Các loài động vật' },
  });

  const colors = await prisma.wordCategory.upsert({
    where: { name: 'màu sắc' },
    update: {},
    create: { name: 'màu sắc', description: 'Các màu sắc' },
  });

  const vehicles = await prisma.wordCategory.upsert({
    where: { name: 'phương tiện' },
    update: {},
    create: { name: 'phương tiện', description: 'Các phương tiện giao thông' },
  });

  const sports = await prisma.wordCategory.upsert({
    where: { name: 'thể thao' },
    update: {},
    create: { name: 'thể thao', description: 'Các môn thể thao' },
  });

  // Seed word pairs
  const wordPairs = [
    // Trái cây
    { wordA: 'dâu tây', wordB: 'cherry', categoryId: fruits.id },
    { wordA: 'cam', wordB: 'quýt', categoryId: fruits.id },
    { wordA: 'xoài', wordB: 'ổi', categoryId: fruits.id },
    { wordA: 'chuối', wordB: 'chuối xanh', categoryId: fruits.id },
    { wordA: 'nho', wordB: 'nho khô', categoryId: fruits.id },

    // Bộ phận cơ thể
    { wordA: 'móng tay', wordB: 'móng chân', categoryId: bodyParts.id },
    { wordA: 'tai trái', wordB: 'tai phải', categoryId: bodyParts.id },
    { wordA: 'mắt', wordB: 'kính mắt', categoryId: bodyParts.id },
    { wordA: 'lông mày', wordB: 'lông mi', categoryId: bodyParts.id },
    { wordA: 'khuỷu tay', wordB: 'đầu gối', categoryId: bodyParts.id },

    // Động vật
    { wordA: 'sư tử', wordB: 'hổ', categoryId: animals.id },
    { wordA: 'chó', wordB: 'mèo', categoryId: animals.id },
    { wordA: 'vịt', wordB: 'ngỗng', categoryId: animals.id },
    { wordA: 'cá heo', wordB: 'cá voi', categoryId: animals.id },
    { wordA: 'thỏ', wordB: 'sóc', categoryId: animals.id },

    // Màu sắc
    { wordA: 'đỏ', wordB: 'hồng', categoryId: colors.id },
    { wordA: 'xanh dương', wordB: 'xanh lá', categoryId: colors.id },
    { wordA: 'vàng', wordB: 'cam', categoryId: colors.id },
    { wordA: 'tím', wordB: 'tím than', categoryId: colors.id },

    // Phương tiện
    { wordA: 'xe đạp', wordB: 'xe máy', categoryId: vehicles.id },
    { wordA: 'máy bay', wordB: 'trực thăng', categoryId: vehicles.id },
    { wordA: 'tàu hỏa', wordB: 'tàu điện', categoryId: vehicles.id },
    { wordA: 'thuyền', wordB: 'canô', categoryId: vehicles.id },

    // Thể thao
    { wordA: 'bóng đá', wordB: 'bóng bầu dục', categoryId: sports.id },
    { wordA: 'cầu lông', wordB: 'tennis', categoryId: sports.id },
    { wordA: 'bơi lội', wordB: 'lặn', categoryId: sports.id },
    { wordA: 'bóng rổ', wordB: 'bóng ném', categoryId: sports.id },
  ];

  let created = 0;
  for (const pair of wordPairs) {
    const existing = await prisma.wordPair.findFirst({
      where: { wordA: pair.wordA, wordB: pair.wordB },
    });
    if (!existing) {
      await prisma.wordPair.create({ data: pair });
      created++;
    }
  }

  console.log(
    `✅ Seed hoàn tất! Đã tạo ${created} cặp từ mới trong ${wordPairs.length - created === 0 ? '6' : created} danh mục.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
