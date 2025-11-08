const token = "fdd18203d93369e47973c463d29f90228738e08eceb88e2f07cb6071d2660cc6"; // replace with actual token

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
