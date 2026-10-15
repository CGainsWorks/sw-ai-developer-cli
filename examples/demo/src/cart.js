export function calculateTotal(items, discount) {
  let total = 0;

  for (const item of items) {
    if (!item) {
      continue;
    }
    total += item.price;
  }

  // Apply the discount code if one was supplied.
  if (discount) {
    total = total * (1 - discount / 100);
  }

  console.log('total', total);
  return total;
}
