const token = "a6f9a24e723a111a35773f6d03477602d51bc03435a452515bb00519689817b0"; // replace with actual token

fetch(`http://localhost:5000/api/auth/verify-email/${token}`, {
  method: "GET",
  headers: {
    "Content-Type": "application/json"
  }
})
.then(res => res.json())
.then(data => {
  console.log("Verification response:", data);
})
.catch(err => {
  console.error("Verification error:", err);
});
