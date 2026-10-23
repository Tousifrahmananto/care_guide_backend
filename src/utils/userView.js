export function userView(user) {
  const { _id, name, email, role, interests, createdAt, updatedAt } = user;
  return { _id, name, email, role, interests, createdAt, updatedAt };
}
